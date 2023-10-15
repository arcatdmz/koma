import {asyncComputed, pausableWatch, useRefHistory} from '@vueuse/core'
import {Mat2d, mat2d, Quat, Vec2, Vec3} from 'linearly'
import {clamp, cloneDeep} from 'lodash'
import {defineStore} from 'pinia'
import {ConfigType} from 'tethr'
import {computed, reactive, shallowRef, toRaw, toRefs} from 'vue'

import {
	assignReactive,
	debounceAsync,
	deepMergeExceptArray,
	loadJson,
	mapPromises,
	mapValuePromises,
	preventConcurrentExecution,
	queryString,
	saveJson,
	showReadwriteDirectoryPicker,
} from '@/util'

import {useBlobStore} from './blobCache'

/**
 * Termiology
 * - Frame: An integer that represents a frame number (starts from 0)
 * - Koma: A frame data that contains multiple Shots
 * - Shot: A single image data that contains images and metadata
 *
 * - flatten data: A data represented as plain JS object and can be JSON-stringified
 * - unflatten data: A data that contains Blob objects
 **/

export const MixBlendModeValues: MixBlendMode[] = [
	'normal',
	'lighten',
	'darken',
	'difference',
]

type MixBlendMode = 'normal' | 'lighten' | 'darken' | 'difference'

interface Project<T = Blob> {
	name: string
	fps: number
	captureShot: {frame: number; layer: number}
	previewRange: [number, number]
	onionskin: number
	komas: Koma<T>[]
	resolution: Vec2
	timeline: {
		zoomFactor: number
		markerSounds: Record<string, T>
		drawing: PaperJSData
	}
	isLooping: boolean
	ShootCondition: JSCode
	cameraConfigs: CameraConfigs
	visibleProperties: Record<string, {visible: boolean; color: string}>
	viewport: {
		transform: Mat2d | 'fit'
		liveviewTransform: Mat2d
		shotTransform: Mat2d
		overlay: SVGString
		overlayMaskOpacity: number
		overlayLineOpacity: number
		onionskinBlend: MixBlendMode
	}
	layers: {
		opacity: number
		mixBlendMode: MixBlendMode
	}[]
	audio: {
		src?: T
		startFrame: number
	}
}

type UndoableData = Pick<Project, 'komas' | 'captureShot'>

type SVGString = string
type PaperJSData = any
type JSCode = string

type CameraConfigs = Partial<ConfigType>

interface Koma<T = Blob> {
	shots: (Shot<T> | null)[]
	backupShots?: Shot<T>[]
	target?: {
		cameraConfigs?: CameraConfigs
		tracker?: {
			position: Vec3
			rotation: Quat
		}
		dmx?: number[]
	}
	markers?: Marker[]
}

interface Marker {
	label: string
	verticalPosition: number
	duration: number
	color: string
	sound?: string
}

export interface Shot<T = Blob> {
	lv: T
	jpg: T
	raw?: T
	cameraConfigs: CameraConfigs
	tracker?: {
		position: Vec3
		rotation: Quat
	}
	dmx?: number[]
	shootTime?: number
	captureDate?: number
}

const emptyProject: Project = {
	name: 'Untitled',
	fps: 15,
	previewRange: [0, 0],
	onionskin: 0,
	timeline: {
		zoomFactor: 1,
		markerSounds: {},
		drawing: null,
	},
	isLooping: false,
	ShootCondition: '() => true',
	cameraConfigs: {
		focalLength: 50,
		focusDistance: 24,
		aperture: 5.6,
		shutterSpeed: '1/100',
		iso: 100,
		colorTemperature: 5500,
	},
	visibleProperties: {
		shootTime: {visible: true, color: '#ffffff'},
		focalLength: {visible: true, color: '#ff0000'},
		focusDistance: {visible: true, color: '#00ff00'},
		aperture: {visible: true, color: '#0000ff'},
		shutterSpeed: {visible: true, color: '#ffff00'},
		iso: {visible: true, color: '#00ffff'},
		colorTemperature: {visible: true, color: '#ff00ff'},
	},
	captureShot: {frame: 0, layer: 0},
	komas: [],
	resolution: [1920, 1280],
	viewport: {
		transform: 'fit',
		liveviewTransform: mat2d.identity,
		shotTransform: mat2d.identity,
		overlay: `
			<path class="letterbox" d="m0,0v1h1V0H0Zm.9.9H.1V.1h.8v.8Z"/>
			<line class="line" x1="0" y1=".5" x2="1" y2=".5" />
			<line class="line" x1=".5" y1="0" x2=".5" y2="1" />
		`,
		overlayMaskOpacity: 0.5,
		overlayLineOpacity: 1,
		onionskinBlend: 'normal',
	},
	layers: [],
	audio: {
		startFrame: 0,
	},
}

export const useProjectStore = defineStore('project', () => {
	const blobCache = useBlobStore()

	const directoryHandle = shallowRef<FileSystemDirectoryHandle | null>(null)

	const isSavedToDisk = asyncComputed(
		async () =>
			directoryHandle.value &&
			directoryHandle.value !== (await blobCache.localDir)
	)

	const project = reactive<Project>(cloneDeep(emptyProject))

	blobCache.localDir.then(handler => open(handler))

	const undoableData = computed<UndoableData>({
		get() {
			return {
				captureShot: project.captureShot,
				komas: project.komas,
			}
		},
		set(data) {
			project.captureShot = data.captureShot
			project.komas = data.komas
		},
	})

	const history = useRefHistory(undoableData, {capacity: 400, clone: cloneDeep})

	const allKomas = computed<Koma[]>(() => {
		const komaNumberToFill =
			Math.max(project.captureShot.frame - project.komas.length + 1, 0) + 1

		return [
			...project.komas,
			...Array(komaNumberToFill)
				.fill(null)
				.map(() => ({shots: []})),
		]
	})

	// Open and Save Projects
	async function createNew() {
		assignReactive(project, cloneDeep(emptyProject))

		history.clear()

		if (directoryHandle.value?.name === '') {
			for await (const key of directoryHandle.value.keys()) {
				directoryHandle.value.removeEntry(key)
			}
		}
	}

	const {fn: open, isExecuting: isOpening} = preventConcurrentExecution(
		async (handler?: FileSystemDirectoryHandle) => {
			directoryHandle.value = handler ?? (await showReadwriteDirectoryPicker())

			const flatProject = await loadJson<Project<string>>(
				directoryHandle,
				'project.json'
			)

			const unflatProject: Project<Blob> = {
				...flatProject,
				timeline: {
					...flatProject.timeline,

					markerSounds: await mapValuePromises(
						flatProject.timeline.markerSounds,
						src => blobCache.open(directoryHandle, src)
					),
				},
				komas: await mapPromises(flatProject.komas, async koma => {
					const shots = await mapPromises(koma.shots, shot => {
						if (shot === null) return null
						return openShot(shot)
					})

					const backupShots = koma.backupShots
						? await mapPromises(koma.backupShots, openShot)
						: undefined

					return {...koma, shots, backupShots}
				}),
				audio: {
					...flatProject.audio,
					src: flatProject.audio.src
						? await blobCache.open(directoryHandle, flatProject.audio.src)
						: undefined,
				},
			}

			// In case the latest project format has more properties than the saved one,
			// merge the saved state with the default state
			const mergedProject = deepMergeExceptArray(unflatProject, emptyProject)

			autoSave.pause()
			{
				assignReactive(project, mergedProject)
				history.clear()
			}
			autoSave.resume()
		},
		() => undefined
	)

	async function saveAs() {
		const handler = await showReadwriteDirectoryPicker()

		directoryHandle.value = handler

		if (project.name === emptyProject.name && handler.name !== '') {
			project.name = handler.name
		}

		await save()
	}

	async function saveInOpfs() {
		directoryHandle.value = await blobCache.localDir
		await save()
	}

	const {fn: save, isExecuting: isSaving} = debounceAsync(async () => {
		console.time('save')

		try {
			if (directoryHandle.value === null) {
				directoryHandle.value = await blobCache.localDir
			}

			const flatProject: Project<string> = {
				...toRaw(project),
				timeline: {
					...project.timeline,
					markerSounds: await mapValuePromises(
						project.timeline.markerSounds,
						(src, name) =>
							blobCache.save(directoryHandle, `marker_${name}.wav`, src)
					),
				},
				komas: await mapPromises(project.komas, async (koma, frame) => {
					const shots = await mapPromises(koma.shots, (shot, layer) => {
						if (shot === null) return null
						return saveShot(shot, frame, {layer})
					})

					const backupShots = koma.backupShots
						? await mapPromises(koma.backupShots, (shot, index) =>
								saveShot(shot, frame, {backup: index})
						  )
						: undefined

					return {...koma, shots, backupShots}
				}),
				audio: {
					...project.audio,
					src: project.audio.src
						? await blobCache.save(
								directoryHandle,
								'audio.wav',
								project.audio.src
						  )
						: undefined,
				},
			}

			await saveJson(directoryHandle, flatProject, 'project.json')
		} finally {
			console.timeEnd('save')
		}
	})

	async function openShot(shot: Shot<string>): Promise<Shot> {
		const lv = await blobCache.open(directoryHandle, shot.lv)
		const jpg = await blobCache.open(directoryHandle, shot.jpg)
		const raw = shot.raw
			? await blobCache.open(directoryHandle, shot.raw)
			: undefined

		return {...shot, lv, jpg, raw}
	}

	// Saves a frame to the project directrory and replace all Blob entries with the name of the file
	async function saveShot(
		shot: Shot,
		frame: number,
		query: Record<string, string | number>
	): Promise<Shot<string>> {
		const basename = [project.name, queryString(query)].join('_')

		const lv = await saveImageSequence(shot.lv, basename + '_lv', frame, 'jpg')
		const jpg = await saveImageSequence(shot.jpg, basename, frame, 'jpg')
		const raw = shot.raw
			? await saveImageSequence(shot.raw, basename, frame, 'dng')
			: undefined

		return {...shot, lv, jpg, raw}
	}

	// Save the blob image to the project directrory and returns the name of the file
	async function saveImageSequence(
		blob: Blob,
		basename: string,
		frame: number,
		extension: string
	) {
		const suffix = frame.toString().padStart(4, '0')
		const filename = `${basename}_${suffix}.${extension}`

		return blobCache.save(directoryHandle, filename, blob)
	}

	// Enable autosave
	const autoSave = pausableWatch(project, save, {deep: true, flush: 'sync'})

	//----------------------------------------------------------------------------
	// Mutations

	function setInPoint(value: number) {
		const inPoint = Math.min(value, project.previewRange[1])
		project.previewRange = [inPoint, project.previewRange[1]]
	}

	function setOutPoint(value: number) {
		const outPoint = clamp(
			value,
			project.previewRange[0],
			allKomas.value.length - 1
		)

		project.previewRange = [project.previewRange[0], outPoint]
	}

	function shot(frame: number, layer: number): Shot | null {
		return project.komas[frame]?.shots?.at(layer) ?? null
	}

	function setShot(frame: number, layer: number, shot: Shot) {
		while (frame >= project.komas.length) {
			project.komas.push({shots: []})
		}

		let koma = project.komas[frame] ?? {}

		if (!koma.shots) {
			// If there is no frame, create a new frame
			project.komas[frame] = koma = {...koma, shots: []}
		}

		while (layer >= koma.shots.length) {
			// If there is not enough layer, push layers
			koma.shots.push(null)
		}

		koma.shots[layer] = shot
	}

	function layer(layer: number) {
		while (layer >= project.layers.length) {
			project.layers.push({opacity: 1, mixBlendMode: 'normal'})
		}

		return project.layers[layer]
	}

	function layerCount(frame: number) {
		return project.komas[frame]?.shots?.length ?? 0
	}

	function setDuration(frames: number) {
		while (frames >= project.komas.length) {
			project.komas.push({shots: []})
		}
	}

	return {
		...toRefs(project),
		undo: history.undo,
		redo: history.redo,
		createNew,
		open,
		saveAs,
		saveInOpfs,
		allKomas,
		setInPoint,
		setOutPoint,
		isOpening,
		isSaving,
		isSavedToDisk,
		shot,
		setShot,
		layer,
		layerCount,
		setDuration,
	}
})
