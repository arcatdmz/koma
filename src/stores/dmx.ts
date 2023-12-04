import {range} from 'lodash'
import {defineStore} from 'pinia'

import {useOscStore} from './osc'
import {useAppConfigStore} from 'tweeq'
import {watchEffect} from 'vue'

export const useDmxStore = defineStore('dmx', () => {
	const osc = useOscStore()
	const appConfig = useAppConfigStore()

	const senders = osc.senders(
		Object.fromEntries(
			range(16).map(i => [
				`dmx${i + 1}`,
				{address: `/dmx${i + 1}`, type: 'f', default: 0},
			])
		)
	)

	const values = Object.values(senders)

	const cachedValues = values.map((_, i) => {
		return appConfig.ref(`dmx${i + 1}`, 1)
	})

	cachedValues.forEach((cache, i) => {
		values[i].value = cache.value
		watchEffect(() => {
			cache.value = values[i].value
		})
	})

	return {values}
})
