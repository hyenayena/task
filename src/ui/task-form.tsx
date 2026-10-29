import React from 'react';
import type {MountControl, UiElement} from '../../../../src/api.js';
import type {Field} from '../tasks.js';
import {Form, ListPicker, type FormField, type FormValue} from './kit.js';

export type TaskFormValues = {id: string; name: string; status: string; description: string; fields: Field[]};

export type TaskFormAction = 'save' | 'discuss';

export type TaskFormSpec = {
	title: string;
	project: string;
	id: string;
	isNew: boolean;
	status: string;
	statusHint?: string;
	description: string;
	descriptionReadOnly?: boolean;
	fields: Field[];
	namePlaceholder?: string;
	save: (values: TaskFormValues) => void;
	validateKey: (key: string, taken: string[]) => string | undefined;
	onDone: (action: TaskFormAction) => void;
};

const BUTTONS = [
	{id: 'cancel', label: 'Cancel'},
	{id: 'save', label: 'Save'},
	{id: 'discuss', label: 'Save and discuss'},
];

const EXTRA = 'extra:';

const pick = (values: FormValue[], id: string): string => values.find(v => v.id === id)?.value ?? '';

export function toTaskValues(values: FormValue[]): TaskFormValues {
	return {
		id: pick(values, 'id'),
		name: pick(values, 'name'),
		status: pick(values, 'status'),
		description: pick(values, 'description'),
		fields: values.filter(v => v.id.startsWith(EXTRA) || v.id.startsWith('added:')).map(v => ({key: v.label, value: v.value})),
	};
}

export function taskForm(control: MountControl, spec: TaskFormSpec): UiElement {
	const fields: FormField[] = [
		{id: 'project', label: 'Project', value: spec.project, readOnly: true},
		{id: 'id', label: 'ID', value: spec.id, ...(!spec.isNew && {readOnly: true})},
		...(spec.isNew ? [{id: 'name', label: 'Name', value: '', placeholder: spec.namePlaceholder ?? 'spaces allowed; the file name is its kebab-case form'}] : []),
		{id: 'status', label: 'Status', value: spec.status, ...(spec.statusHint !== undefined && {placeholder: spec.statusHint})},
		{id: 'description', label: 'Description', value: spec.description, placeholder: 'what the task is about (required)', ...(spec.descriptionReadOnly && {readOnly: true})},
		...spec.fields.map((f, i) => ({id: `${EXTRA}${i}`, label: f.key, value: f.value})),
	];
	const host = control.host ? {host: control.host} : {};
	return (
		<Form
			title={spec.title}
			fields={fields}
			buttons={BUTTONS}
			add={{label: 'Add field', validate: (label, values) => spec.validateKey(label, values.map(v => v.label))}}
			onButton={(id, values) => {
				if (id === 'cancel') {
					control.close();
					return undefined;
				}
				spec.save(toTaskValues(values));
				control.close();
				spec.onDone(id === 'discuss' ? 'discuss' : 'save');
				return undefined;
			}}
			onCancel={() => control.close()}
			{...host}
		/>
	);
}

export function projectPicker(control: MountControl, projects: string[], onPick: (project: string) => void): UiElement {
	const host = control.host ? {host: control.host} : {};
	return (
		<ListPicker
			title="New task · which project?"
			empty="No isolated projects"
			action="choose"
			items={projects.map(p => ({id: p, label: p}))}
			onPick={onPick}
			close={() => control.close()}
			{...host}
		/>
	);
}
