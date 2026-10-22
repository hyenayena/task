import path from 'node:path';
import type {ModulePlugin} from '../../../src/api.js';
import {createTaskCommand} from './commands.js';
import {noopLog} from './log.js';

/** Sibling data dirs: the md hub (<YENA_DATA>/md) and the project module (<YENA_DATA>/project). */
export const pathsFor = (dataDir: string): {md: string; projectState: string} => {
	const root = path.dirname(dataDir);
	return {md: path.join(root, 'md', 'projects'), projectState: path.join(root, 'project', 'state.json')};
};

const plugin: ModulePlugin = host => [createTaskCommand({...pathsFor(host.dataDir), log: host.log ?? noopLog})];

export default plugin;
