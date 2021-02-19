'use strict';

const has = require('has');
const inspect = require('object-inspect');
const hasPrivateFields = require('has-private-fields')();
const CDP = hasPrivateFields && require('chrome-remote-interface'); // eslint-disable-line global-require

const getThis = function () {
	delete global.$getThis;
	return this; // eslint-disable-line no-invalid-this
};

module.exports = async function getPrivateFields(object) {
	if (!hasPrivateFields) {
		return [];
	}

	process.kill(process.pid, 'SIGUSR1');
	const client = await new CDP({ port: 9229 });
	await client.Runtime.enable();

	const post = (command, arg) => client.Runtime[command](arg);

	const getReceiver = (objectId) => {
		global.$getThis = getThis;
		return post('callFunctionOn', {
			functionDeclaration: '$getThis',
			objectId,
			returnByValue: true,
		});
	};

	global.$object = () => {
		delete global.$object;
		return object;
	};
	const { result: { objectId } } = await post(
		'evaluate',
		{ expression: '$object()' },
	);

	const { privateProperties } = await post(
		'getProperties',
		{ objectId },
	);

	const properties = await Promise.all((privateProperties || []).map(async (field) => {
		const {
			name,
			get,
			set,
			value: v,
		} = field;

		let value;
		let clonedValue;
		let functionData;
		if (!get && !set) {
			const {
				type,
				description,
				objectId: valueID,
				unserializableValue,
			} = v;

			if (has(v, 'value')) {
				value = v.value;
			} else if (has(v, 'unserializableValue')) {
				if (unserializableValue === 'Infinity') {
					value = Infinity;
				} else if (unserializableValue === '-Infinity') {
					value = -Infinity;
				} else if (unserializableValue === '-0') {
					value = -0;
				} else if (type === 'bigint') {
					value = BigInt(unserializableValue.slice(0, -1));
				} else {
					throw new SyntaxError(`Unknown unserializable value found! Please report this: ${inspect(field)}`);
				}
			} else if (type === 'object') {
				// get a structured clone of the actual private field object value
				const { result } = await getReceiver(valueID);
				({ value: clonedValue } = result);
			} else if (type === 'symbol') {
				// eslint-disable-next-line no-restricted-properties
				clonedValue = Symbol.for(description.slice(7, -1)); // description.slice('Symbol('.length, -')'.length);
			} else if (type === 'function') {
				functionData = { type, description };
			}
		} else {
			/* eslint require-atomic-updates: 0, no-param-reassign: 0 */

			// get a structured clone of the actual private accessor function
			if (get) {
				get.clonedValue = await getReceiver(get.objectId).value;
			}

			if (set) {
				set.clonedValue = await getReceiver(set.objectId).value;
			}
		}
		return {
			name,
			...get && {
				get: {
					type: get.type,
					description: get.description,
				},
			},
			...set && {
				set: {
					type: set.type,
					description: set.description,
				},
			},
			...!get && !set && {
				...clonedValue ? { clonedValue } : functionData || { value },
			},
		};
	}));
	await client.close();
	return properties;
};
