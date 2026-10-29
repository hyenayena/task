import type {ModulePlugin} from '../../../src/api.js';
import {createTaskCommand} from './commands.js';
import {docsRootFor, isolatedProjects} from './deps/project.js';
import {noopLog} from './log.js';

export const depsFor = (dataDir: string): {md: string; isolated: () => string[]} => ({
	md: docsRootFor(dataDir),
	isolated: () => isolatedProjects(dataDir),
});

const plugin: ModulePlugin = host => [createTaskCommand({...depsFor(host.dataDir), log: host.log ?? noopLog})];

export default plugin;
