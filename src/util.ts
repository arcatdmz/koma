import {readonly, Ref, ref} from 'vue'

export function mapToPromises<T, U>(
	array: T[],
	fn: (item: T, index: number) => Promise<U> | U
): Promise<U[]> {
	return Promise.all(array.map(fn))
}

export function queryString(query: Record<string, string | number>) {
	return Object.entries(query)
		.map(([key, value]) => `${key}=${value}`)
		.join('&')
}

export async function showReadwriteDirectoryPicker() {
	const handle = await window.showDirectoryPicker({id: 'saveFile'})

	await queryPermission(handle)

	return handle
}

// File System Access API utils
export async function loadJson<T>(
	handler: Ref<FileSystemDirectoryHandle | null>,
	filename: string
): Promise<T> {
	if (!handler.value) throw new Error('No directory handler')

	const h = await handler.value.getFileHandle(filename)
	const f = await h.getFile()
	const text = await f.text()

	return JSON.parse(text)
}

export async function saveJson<T>(
	handler: Ref<FileSystemDirectoryHandle | null>,
	data: T,
	fileName: string
) {
	if (!handler.value) throw new Error('No directory handler')

	const json = JSON.stringify(data)

	const h = await handler.value.getFileHandle(fileName, {
		create: true,
	})

	const w = await h.createWritable()
	await w.write(json)
	await w.close()
}

/**
 * Query and request readwrite permission for a FileSystemhandle
 */
export async function queryPermission(
	handle: FileSystemHandle,
	mode: FileSystemHandlePermissionDescriptor['mode'] = 'readwrite'
) {
	const permission = await handle.queryPermission({mode})

	if (permission !== 'granted') {
		const permission = await handle.requestPermission({mode})
		if (permission === 'denied') throw new Error('Permission denied')
	}
}

const urlForBlob = new WeakMap<Blob, string>()

export function getObjectURL(blob: Blob) {
	let url = urlForBlob.get(blob)
	if (!url) {
		url = URL.createObjectURL(blob)
		urlForBlob.set(blob, url)
	}
	return url
}

export function assignReactive<T extends Record<string, any>>(
	reactive: T,
	source: T
) {
	for (const key of Object.keys(source)) {
		;(reactive as any)[key] = (source as any)[key]
	}
}

export function debounceAsync(fn: () => Promise<void>) {
	const isExecuting = ref(false)
	let willExecute = false

	const debouncedFn = async () => {
		if (isExecuting.value) {
			willExecute = true
			return
		}

		try {
			isExecuting.value = true
			await fn()
		} finally {
			isExecuting.value = false
		}

		if (willExecute) {
			willExecute = false
			debouncedFn()
		}
	}

	return {fn: debouncedFn, isExecuting: readonly(isExecuting)}
}

// Asyncな関数が重複して実行されないようにする
export function singleAsync<T extends unknown[]>(
	fn: (...arg: T) => Promise<void>
) {
	const isExecuting = ref(false)

	const singleFn = async (...arg: T) => {
		if (isExecuting.value) return

		try {
			isExecuting.value = true
			await fn(...arg)
		} finally {
			isExecuting.value = false
		}
	}

	return {fn: singleFn, isExecuting: readonly(isExecuting)}
}

export function toTime(ms: number) {
	const sec = Math.floor(ms / 1000)
	const min = Math.floor(sec / 60)
	const hour = Math.floor(min / 60)

	return [
		hour ? String(hour) : false,
		String(min % 60).padStart(2, '0'),
		String(sec % 60).padStart(2, '0'),
	]
		.filter(Boolean)
		.join(':')
}
