/**
*	auto-handoff.ts
*
*	OpenCode plugin — periodic + exit handoff writer.
*	Writes .handoff/<timestamp>.md every N user-turns and on session exit.
*	No keywords, no load — just automatic snapshots.
*
*	Install: cp auto-handoff.ts ~/.config/opencode/plugins/auto-handoff.ts
*	Config:  ~/.config/opencode/auto-handoff.json
*	Log:     ~/.config/opencode/auto-handoff.log
*	Output: <project>/.handoff/<timestamp>.md
*
*	@example ~/.config/opencode/auto-handoff.json
*	{
*		"every_turns": 20,
*		"on_exit": true,
*		"on_start": true,
*		"keep_last": 20,
*		"log_level": "info" // silent, info, debug
*	}
*
*	@name auto-handoff plugin.
*	@version 1.0.6
*	@author Alejandro Carraretto
*	@author MiniMax-M3
*	@license MIT
*/

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Paths ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || homedir();
const CONFIG_DIR = `${HOME}/.config/opencode`;
const CONFIG_FILE = `${CONFIG_DIR}/auto-handoff.json`;
const LOG_FILE = `${CONFIG_DIR}/auto-handoff.log`;

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS = {
	every_turns: 20,
	on_exit: true,
	on_start: true,
	keep_last: 20,
	log_level: "info" as "silent" | "info" | "debug",
} as const;

type AutoHandoffOptions = Partial<typeof DEFAULTS>;

// ─── Logger ────────────────────────────────────────────────────────────────

class Logger
{
	private level: number;

	constructor( level: "silent" | "info" | "debug" )
	{
		this.level = { silent: 0, info: 1, debug: 2 }[ level ];
	}

	log( level: "info" | "debug" | "error", ...args: unknown[] ): void
	{
		if ( this.level === 0 ) return;
		if ( level === "debug" && this.level < 2 ) return;

		const label = level.toUpperCase();
		const msg = args.map( a =>
			typeof a === "string" ? a : JSON.stringify( a )
		).join( " " );

		try
		{
			appendFileSync( LOG_FILE, `[${new Date().toISOString()}] [${label}]: ${msg}\n` );
		}
		catch { /* log write failed — non-fatal */ }
	}
}

// ─── Config ────────────────────────────────────────────────────────────────

function loadConfig(): AutoHandoffOptions
{
	if ( !existsSync( CONFIG_FILE ) ) return {};
	try
	{
		return JSON.parse( readFileSync( CONFIG_FILE, "utf8" ) ) as AutoHandoffOptions;
	}
	catch
	{
		return {};
	}
}

function mergeOptions( fileCfg: AutoHandoffOptions, raw?: PluginOptions ): typeof DEFAULTS
{
	const fromRaw: AutoHandoffOptions = {};
	if ( raw && typeof raw === "object" )
	{
		for ( const [ k, v ] of Object.entries( raw ) )
		{
			if ( k in DEFAULTS ) ( fromRaw as Record<string, unknown> )[ k ] = v;
		}
	}
	return { ...DEFAULTS, ...fileCfg, ...fromRaw };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function timestamp(): string
{
	return new Date().toISOString().replace( /[:.]/g, "-" ).slice( 0, 16 );
}

interface MessageLike
{
	info: { role: "user" | "assistant"; id?: string };
	parts: Array<{ type: string; text?: string }>;
}

function extractText( msg: MessageLike ): string
{
	return ( msg.parts ?? [] )
		.filter( p => p.type === "text" && typeof p.text === "string" )
		.map( p => p.text! )
		.join( "\n" )
		.trim();
}

// ─── Templates ─────────────────────────────────────────────────────────────

const readTemplate = ( handoff: string ): string =>
	`[Resume previous session — handoff loaded]\n\n` +
	`A handoff from a previous session was loaded. Follow these steps:\n` +
	`1. Briefly acknowledge the resume (1-2 lines).\n` +
	`2. Present a structured summary using these sections:\n` +
	`   - **Where we left off**: 1-2 sentences on the last task/state.\n` +
	`   - **Next step**: what was pending or in progress.\n` +
	`   - **Key context**: names, files, decisions, constraints mentioned.\n` +
	`   - **Recent activity**: brief recap of the last few messages.\n` +
	`3. Wait for the user's next instruction.\n\n` +
	`---\n\n` +
	`${handoff}`;

const writeTemplate = ( ts: string, reason: string, recentCount: number, messagesBlock: string ): string =>
	`# Handoff — ${ts}\n\n` +
	`## Reason\n${reason}\n\n` +
	`## Recent messages (last ${recentCount})\n${messagesBlock}\n`;

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( ctx: PluginInput, rawOptions?: PluginOptions ) =>
{
	const opts = mergeOptions( loadConfig(), rawOptions );
	const logger = new Logger( opts.log_level );
	const projectDir = ctx.directory;

	const messages: Array<{ role: string; content: string }> = [];
	let lastWriteTime = 0;
	let pendingHandoff: string | null = null;
	let handoffInjected = false;

	const writeHandoff = ( reason: string ): void =>
	{
		try
		{
			const ts = timestamp();
			const dir = join( projectDir, ".handoff" );
			const path = join( dir, `${ts}.md` );

			const recent = messages.slice( -opts.keep_last );
			const messagesBlock = recent.length > 0
				? recent.map( m => `- [${m.role}] ${m.content.slice( 0, 200 )}` ).join( "\n" )
				: "(no messages captured)";

			const content = writeTemplate( ts, reason, recent.length, messagesBlock );

			mkdirSync( dir, { recursive: true } );
			writeFileSync( path, content );
			lastWriteTime = Date.now();
			logger.log( "info", `Handoff written (${reason}): ${path}` );
		}
		catch ( err )
		{
			logger.log( "error", "write failed:", ( err as Error ).message );
		}
	};

	const onExit = (): void =>
	{
		if ( !opts.on_exit ) return;
		if ( Date.now() - lastWriteTime < 5000 ) return;
		try { writeHandoff( "exit" ); } catch { /* non-fatal */ }
	};
	process.once( "exit", onExit );

	if ( opts.on_start )
	{
		try
		{
			const dir = join( projectDir, ".handoff" );
			if ( existsSync( dir ) )
			{
				const files = readdirSync( dir )
					.filter( f => f.endsWith( ".md" ) )
					.sort()
					.reverse();
				if ( files.length > 0 )
				{
					const latest = files[ 0 ];
					pendingHandoff = readFileSync( join( dir, latest ), "utf8" );
					logger.log( "info", `Handoff loaded: ${latest}` );
				}
			}
		}
		catch ( err )
		{
			logger.log( "error", "on_start load failed:", ( err as Error ).message );
		}
	}

	logger.log( "info", `Initialized | project: ${projectDir} | cfg: ${JSON.stringify( opts )}` );

	return {
		"experimental.chat.messages.transform": async ( _input, output ) =>
		{
			try
			{
				if ( pendingHandoff && !handoffInjected && output.messages )
				{
					output.messages.unshift( {
						info: { role: "user", id: "handoff-resume" },
						parts: [ { type: "text", text: readTemplate( pendingHandoff ) } ],
					} as MessageLike );
					handoffInjected = true;
					messages.length = 0;
					logger.log( "info", "Handoff injected into context" );
				}

				if ( !output.messages?.length ) return;

				for ( const msg of output.messages )
				{
					const text = extractText( msg as MessageLike );
					if ( !text ) continue;
					const last = messages[ messages.length - 1 ];
					if ( last && last.role === msg.info.role && last.content === text ) continue;
					messages.push( { role: msg.info.role, content: text } );
				}

				const userTurns = messages.filter( m => m.role === "user" ).length;
				if ( userTurns > 0 && userTurns % opts.every_turns === 0 )
				{
					writeHandoff( `periodic (${userTurns} turns)` );
				}
			}
			catch ( err )
			{
				logger.log( "error", "messages.transform:", ( err as Error ).message );
			}
		},

		dispose: async () =>
		{
			process.removeListener( "exit", onExit );
			if ( opts.on_exit )
			{
				try { writeHandoff( "dispose" ); } catch { /* non-fatal */ }
			}
			logger.log( "info", "Disposed" );
		},
	};
} ) satisfies Plugin;
