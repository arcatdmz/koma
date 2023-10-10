import {Ref} from 'vue'

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

export async function getDirectoryHandle() {
	const handle = await window.showDirectoryPicker({id: 'saveFile'})

	await queryReadWritePermission(handle)

	return handle
}

export async function openBlob(
	handler: Ref<FileSystemDirectoryHandle | null>,
	filename: string
) {
	if (!handler.value) throw new Error('No directory handler')

	const h = await handler.value.getFileHandle(filename)
	return await h.getFile()
}

/**
 * Memoized function for saving a blob to a file.
 * @returns The filename the blob was saved to.
 */
export async function saveBlob(
	handler: Ref<FileSystemDirectoryHandle | null>,
	filename: string,
	blob: Blob
) {
	if (!handler.value) throw new Error('No directory handler')

	let map = savedFilenameForBlob.get(handler.value)

	if (!map) {
		map = new WeakMap()
		savedFilenameForBlob.set(handler.value, map)
	}

	if (map.get(blob) !== filename) {
		const fileHandle = await handler.value.getFileHandle(filename, {
			create: true,
		})

		await queryReadWritePermission(fileHandle)

		const w = await fileHandle.createWritable()
		await w.write(blob)
		await w.close()

		map.set(blob, filename)
	}

	return filename
}

const savedFilenameForBlob = new WeakMap<
	FileSystemDirectoryHandle,
	WeakMap<Blob, string>
>()

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
async function queryReadWritePermission(handle: FileSystemHandle) {
	const permission = await handle.queryPermission({mode: 'readwrite'})

	if (permission !== 'granted') {
		const permission = await handle.requestPermission({mode: 'readwrite'})
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
