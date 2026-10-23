import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { projectNamePattern } from "./config.ts";
import { CliError } from "./errors.ts";

// Copies the bundled local starter. No remote template fetch, no credentials:
// the template ships no .env or .dev.vars files.

const templateRoot = fileURLToPath(new URL("../templates/starter/", import.meta.url));

// npm drops .gitignore files from published packages, so the template stores it renamed.
const renamedFiles: Record<string, string> = { _gitignore: ".gitignore" };

// Entries that do not make a destination "non-empty".
const ignoredEntries = new Set([".git"]);

export type StarterOptions = {
	cwd: string;
	dir: string;
	name: string | undefined;
	force: boolean;
};

export type StarterResult = {
	target: string;
	name: string;
	files: string[];
};

const listTemplateFiles = (dir: string): string[] =>
	readdirSync(dir)
		.sort()
		.flatMap((entry) => {
			const path = join(dir, entry);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new CliError(`Starter template contains a symbolic link: ${entry}`);
			return stat.isDirectory() ? listTemplateFiles(path) : [relative(templateRoot, path)];
		});

const outputPath = (templatePath: string) => {
	const parts = templatePath.split(sep);
	const last = parts.pop() ?? "";
	return [...parts, renamedFiles[last] ?? last].join(sep);
};

const resolveTarget = (cwd: string, dir: string) => {
	if (dir.includes("\0")) throw new CliError("Target directory contains a NUL character", { usage: true });
	const target = resolve(cwd, dir);
	if (target === parse(target).root) {
		throw new CliError(`Refusing to write a starter into the filesystem root (${target})`, {
			hint: "Pass a project directory, for example `takebase create my-app`.",
		});
	}
	return target;
};

const resolveName = (target: string, name: string | undefined) => {
	const candidate = name ?? basename(target);
	if (projectNamePattern.test(candidate)) return candidate;
	if (name !== undefined) {
		throw new CliError(`Invalid project name "${name}"`, {
			usage: true,
			hint: "Use 1-63 lowercase letters, digits and hyphens, starting and ending with a letter or digit.",
		});
	}
	throw new CliError(`Directory name "${candidate}" is not a valid project name`, {
		usage: true,
		hint: "Pass --name <name> using lowercase letters, digits and hyphens.",
	});
};

const checkTargetDirectory = (target: string, force: boolean) => {
	if (!existsSync(target)) return;
	const stat = lstatSync(target);
	if (stat.isSymbolicLink()) {
		throw new CliError(`Target ${target} is a symbolic link`, { hint: "Pass the real directory path instead." });
	}
	if (!stat.isDirectory()) {
		throw new CliError(`Target ${target} exists and is not a directory`, { hint: "Choose another directory." });
	}
	const entries = readdirSync(target).filter((entry) => !ignoredEntries.has(entry));
	if (entries.length > 0 && !force) {
		throw new CliError(`Target ${target} is not empty (${entries.length} existing entries)`, {
			hint: "Choose an empty directory, or pass --force to write the starter files into it and overwrite files with the same names.",
		});
	}
};

// Every path segment below the target must be a real directory (or absent), and the
// file itself a regular file (or absent), so nothing is written through a link.
const checkDestination = (target: string, file: string) => {
	const destination = join(target, file);
	const fromTarget = relative(target, destination);
	if (fromTarget.startsWith("..") || isAbsolute(fromTarget)) {
		throw new CliError(`Starter file ${file} resolves outside ${target}`);
	}
	const parts = fromTarget.split(sep);
	parts.forEach((_, index) => {
		const path = join(target, ...parts.slice(0, index + 1));
		if (!existsSync(path)) return;
		const stat = lstatSync(path);
		const isFile = index === parts.length - 1;
		if (stat.isSymbolicLink() || (isFile ? !stat.isFile() : !stat.isDirectory())) {
			throw new CliError(`Refusing to write ${file}: ${path} is not a regular ${isFile ? "file" : "directory"}`, {
				hint: "Remove or rename it, or choose another directory.",
			});
		}
	});
	return destination;
};

export const writeStarter = (options: StarterOptions): StarterResult => {
	const target = resolveTarget(options.cwd, options.dir);
	const name = resolveName(target, options.name);
	checkTargetDirectory(target, options.force);

	const templateFiles = listTemplateFiles(templateRoot);
	// Validate every destination before writing anything, so a refusal leaves no partial starter.
	const plan = templateFiles.map((file) => ({
		source: join(templateRoot, file),
		file: outputPath(file),
		destination: checkDestination(target, outputPath(file)),
	}));

	for (const { source, destination } of plan) {
		mkdirSync(join(destination, ".."), { recursive: true });
		writeFileSync(destination, readFileSync(source, "utf8").replaceAll("{{name}}", name));
	}
	return { target, name, files: plan.map(({ file }) => file) };
};
