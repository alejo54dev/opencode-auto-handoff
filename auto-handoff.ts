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
*		"max_stored_files": 10,
*		"max_load_files": 3,
*		"log_level": "info" // silent, info, debug
*	}
*
*	@name auto-handoff plugin.
 *	@version 1.0.18
*	@author Alejandro Carraretto
*	@author MiniMax-M3
*	@license MIT
*/

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Paths ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || homedir();
const CONFIG_DIR = `${HOME}/.config/opencode`;
const CONFIG_FILE = `${CONFIG_DIR}/auto-handoff.json`;
const LOG_FILE = `${CONFIG_DIR}/auto-handoff.log`;

// ─── Defaults & Config ─────────────────────────────────────────────────────

const DEFAULTS = {
	every_turns: 20,
	on_exit: true,
	on_start: true,
	keep_last: 20,
	max_stored_files: 10,
	max_load_files: 3,
	log_level: "info" as "silent" | "info" | "debug",
} as const;

type AutoHandoffOptions = Partial<typeof DEFAULTS>;

function loadConfig(): AutoHandoffOptions
{
	if ( !existsSync( CONFIG_FILE ) ) return {};

	try
	{
		return JSON.parse( readFileSync( CONFIG_FILE, "utf8" ) ) as AutoHandoffOptions;
	}
	catch { return {}; }
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

	const opts = { ...DEFAULTS, ...fileCfg, ...fromRaw };

	opts.keep_last = Math.max( 1, opts.keep_last! );
	opts.max_stored_files = Math.max( 1, opts.max_stored_files! );
	opts.max_load_files = Math.max( 1, opts.max_load_files! );

	return opts as typeof DEFAULTS;
}

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

// ─── Helpers ───────────────────────────────────────────────────────────────

function timestamp(): string
{
	const d = new Date();
	const y = d.getUTCFullYear();
	const m = String( d.getUTCMonth() + 1 ).padStart( 2, "0" );
	const day = String( d.getUTCDate() ).padStart( 2, "0" );
	const h = String( d.getUTCHours() ).padStart( 2, "0" );
	const min = String( d.getUTCMinutes() ).padStart( 2, "0" );
	return `${y}-${m}-${day}-${h}${min}`;
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

function listHandoffFiles( dir: string ): string[]
{
	if ( !existsSync( dir ) ) return [];
	return readdirSync( dir )
		.filter( f => f.endsWith( ".md" ) )
		.sort();
}

function rotateHandoffFiles( dir: string, maxStored: number ): void
{
	const files = listHandoffFiles( dir );
	if ( files.length <= maxStored ) return;

	const excess = files.length - maxStored;
	for ( let i = 0; i < excess; i++ )
	{
		try { unlinkSync( join( dir, files[ i ] ) ); }
		catch { /* non-fatal */ }
	}
}

function sliceKeepLast( text: string, n: number ): string
{
	const lines = text.split( "\n" );
	const headerIdx = lines.findIndex( l => l.startsWith( "## Recent messages" ) );
	if ( headerIdx === -1 ) return text;

	const headerEnd = headerIdx + 2;
	const body = lines.slice( headerEnd, headerEnd + n );
	return [ ...lines.slice( 0, headerEnd ), ...body ].join( "\n" );
}

// ─── Templates ─────────────────────────────────────────────────────────────

const readTemplate = ( handoff: string ): string =>
	`## Resume previous session — handoff loaded\n\n` +
	`A handoff from a previous session was loaded. ` +
	`Read it and present a structured markdown summary with these sections:\n\n` +
	`- **Where we left off** — last task/state\n` +
	`- **Key context** — files, decisions, constraints\n` +
	`- **Next step** — what was pending\n\n` +
	`Then wait for the user's next instruction.\n\n` +
	`---\n\n` +
	`${handoff}` +
	`\n\n---`;

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
	let lastSeenMessageId: string | null = null;

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

			rotateHandoffFiles( dir, opts.max_stored_files );

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
		if ( messages.length === 0 ) return;

		try { writeHandoff( "exit" ); } catch { /* non-fatal */ }
	};

	process.once( "exit", onExit );

	if ( opts.on_start )
	{
		try
		{
			const dir = join( projectDir, ".handoff" );

			const files = listHandoffFiles( dir );
			const loadCount = Math.min( opts.max_load_files, files.length );

			if ( loadCount > 0 )
			{
				const selected = files.slice( -loadCount );
				const stack = selected
					.map( f => readFileSync( join( dir, f ), "utf8" ) )
					.join( "\n\n---\n\n" );

				pendingHandoff = sliceKeepLast( stack, opts.keep_last );
				logger.log( "info", `Handoff loaded: ${loadCount} file(s), sliced to ${opts.keep_last} entries` );
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
					if ( msg.info.role === "user" && msg.info.id === "handoff-resume" ) continue;

					if ( msg.info.id && msg.info.id <= ( lastSeenMessageId ?? "" ) ) continue;

					const text = extractText( msg as MessageLike );
					if ( !text ) continue;

					const last = messages[ messages.length - 1 ];
					if ( last && last.content === text ) continue;

					messages.push( { role: msg.info.role, content: text } );

					if ( msg.info.id ) lastSeenMessageId = msg.info.id;
				}

				if ( opts.every_turns > 0 && messages.length >= opts.every_turns )
				{
					writeHandoff( `periodic (${messages.length} messages)` );
					messages.length = 0;
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

			if ( opts.on_exit && messages.length > 0 )
			{
				try { writeHandoff( "dispose" ); } catch { /* non-fatal */ }
			}
			logger.log( "info", "Disposed" );
		},
	};
} ) satisfies Plugin;
