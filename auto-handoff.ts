/**
 *	auto-handoff.ts
 *
 *	OpenCode plugin — periodic + exit handoff writer.
 *	Writes .handoff/<timestamp>.md every N user-turns and on session exit.
 *	No keywords, no load — just automatic snapshots.
 *
 *	Config: passed via opencode plugin options (see AGENTS.md).
 *	Output: <project>/.handoff/<timestamp>.md
 *
 *	@example opencode.json plugin entry
 *	{
 *		"plugin": [
 *			["auto-handoff", {
 *				"every_n_turns": 10,
 *				"on_exit": true,
 *				"recent_messages_count": 10,
 *				"log_level": "info"
 *			}]
 *		]
 *	}
 *
 *	@name auto-handoff
 *	@version 1.0.2
 *	@author Alejandro Carraretto
 *	@license MIT
 */

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS = {
	every_n_turns: 10,
	on_exit: true,
	recent_messages_count: 10,
	log_level: "info" as "silent" | "info" | "debug",
} as const;

type AutoHandoffOptions = Partial<typeof DEFAULTS>;
type LogLevel = AutoHandoffOptions["log_level"];

// ─── Logger ────────────────────────────────────────────────────────────────

const LOG_LEVELS: Record<NonNullable<LogLevel>, number> = {
	silent: 0,
	info: 1,
	debug: 2,
};

function makeLogger( level: NonNullable<LogLevel> )
{
	const threshold = LOG_LEVELS[ level ];
	return ( severity: "info" | "debug" | "error", ...args: unknown[] ): void =>
	{
		if ( threshold === 0 ) return;
		if ( severity === "debug" && threshold < 2 ) return;
		const label = severity.toUpperCase();
		const msg = args.map( a =>
			typeof a === "string" ? a : JSON.stringify( a )
		).join( " " );
		const line = `[auto-handoff] [${label}] ${msg}`;
		if ( severity === "error" ) console.error( line );
		else console.log( line );
	};
}

// ─── Config ────────────────────────────────────────────────────────────────

function mergeOptions( raw?: PluginOptions ): typeof DEFAULTS
{
	const fromRaw: AutoHandoffOptions = {};
	if ( raw && typeof raw === "object" )
	{
		for ( const [ k, v ] of Object.entries( raw ) )
		{
			if ( k in DEFAULTS ) ( fromRaw as Record<string, unknown> )[ k ] = v;
		}
	}
	return { ...DEFAULTS, ...fromRaw };
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

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( ctx: PluginInput, rawOptions?: PluginOptions ) =>
{
	const opts = mergeOptions( rawOptions );
	const log = makeLogger( opts.log_level );
	const projectDir = ctx.directory;

	const messages: Array<{ role: string; content: string }> = [];
	let lastWriteTime = 0;

	const writeHandoff = ( reason: string ): void =>
	{
		try
		{
			const ts = timestamp();
			const dir = join( projectDir, ".handoff" );
			const path = join( dir, `${ts}.md` );

			const recent = messages.slice( -opts.recent_messages_count );
			const messagesBlock = recent.length > 0
				? recent.map( m => `- [${m.role}] ${m.content.slice( 0, 200 )}` ).join( "\n" )
				: "(no messages captured)";

			const content =
				`# Handoff — ${ts}\n\n` +
				`## Reason\n${reason}\n\n` +
				`## Recent messages (last ${recent.length})\n${messagesBlock}\n`;

			mkdirSync( dir, { recursive: true } );
			writeFileSync( path, content );
			lastWriteTime = Date.now();
			log( "info", `Handoff written (${reason}): ${path}` );
		}
		catch ( err )
		{
			log( "error", "write failed:", ( err as Error ).message );
		}
	};

	const onExit = (): void =>
	{
		if ( !opts.on_exit ) return;
		if ( Date.now() - lastWriteTime < 5000 ) return;
		try { writeHandoff( "exit" ); } catch { /* non-fatal */ }
	};
	process.once( "exit", onExit );

	log( "info", `Initialized | project: ${projectDir} | every_n_turns: ${opts.every_n_turns}` );

	return {
		"experimental.chat.messages.transform": async ( _input, output ) =>
		{
			try
			{
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
				if ( userTurns > 0 && userTurns % opts.every_n_turns === 0 )
				{
					writeHandoff( `periodic (${userTurns} turns)` );
				}
			}
			catch ( err )
			{
				log( "error", "messages.transform:", ( err as Error ).message );
			}
		},

		dispose: async () =>
		{
			process.removeListener( "exit", onExit );
			if ( opts.on_exit )
			{
				try { writeHandoff( "dispose" ); } catch { /* non-fatal */ }
			}
			log( "info", "Disposed" );
		},
	};
} ) satisfies Plugin;
