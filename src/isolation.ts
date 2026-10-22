import {readFileSync} from 'node:fs';

/**
 * Reads the project module's state file (<YENA_DATA>/project/state.json, format v1) for the isolated
 * projects of the work session. Modules never import each other's code, so this is a minimal copy of
 * that contract. Anything unexpected counts as nothing isolated.
 */
export function isolatedProjects(file: string): string[] {
	try {
		const raw = JSON.parse(readFileSync(file, 'utf8')) as {v?: unknown; session?: {isolated?: unknown} | null};
		if (raw.v !== 1 || !raw.session) return [];
		const list = raw.session.isolated;
		return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}
