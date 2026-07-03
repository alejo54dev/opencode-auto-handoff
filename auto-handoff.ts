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
*	@version 1.1.0
*	@author Alejandro Carraretto
*	@author MiniMax-M3
*	@license MIT
*/

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin" ;
import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ─── Paths ─────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || homedir() ;
const CONFIG_DIR = `${HOME}/.config/opencode` ;
const CONFIG_FILE = `${CONFIG_DIR}/auto-handoff.json` ;
const LOG_FILE = `${CONFIG_DIR}/auto-handoff.log` ;

// ─── Defaults & Config ─────────────────────────────────────────────────────

const DEFAULTS = {
	every_turns: 20,
	on_exit: true,
	on_start: true,
	keep_last: 20,
	max_stored_files: 10,
	max_load_files: 3,
	log_level: "info" as "silent" | "info" | "debug",
} as const ;

type AutoHandoffOptions = Partial<typeof DEFAULTS> ;

function loadConfig(): AutoHandoffOptions
{
	if ( !existsSync( CONFIG_FILE ) ) return {} ;

	try
	{
		return JSON.parse( readFileSync( CONFIG_FILE, "utf8" ) ) as AutoHandoffOptions ;
	}
	catch ( _err ) { return {} ; }
}

function mergeOptions( fileCfg: AutoHandoffOptions, raw?: PluginOptions ): typeof DEFAULTS
{
	const fromRaw: AutoHandoffOptions = {} ;

	if ( raw && typeof raw === "object" )
	{
		for ( const [ k, v ] of Object.entries( raw ) )
		{
			if ( k in DEFAULTS ) ( fromRaw as Record<string, unknown> )[ k ] = v ;
		}
	}

	const opts = { ...DEFAULTS, ...fileCfg, ...fromRaw } ;

	opts.keep_last = Math.max( 1, opts.keep_last ?? 1 ) ;
	opts.max_stored_files = Math.max( 1, opts.max_stored_files ?? 1 ) ;
	opts.max_load_files = Math.max( 1, opts.max_load_files ?? 1 ) ;

	return opts as typeof DEFAULTS ;
}

// ─── Logger ────────────────────────────────────────────────────────────────

class Logger
{
	private level: number ;

	constructor( level: "silent" | "info" | "debug" )
	{
		this.level = { silent: 0, info: 1, debug: 2 }[ level ] ;
	}

	log( level: "info" | "debug" | "error", ...args: unknown[] ): void
	{
		if ( this.level === 0 ) return ;
		if ( level === "debug" && this.level < 2 ) return ;

		const label = level.toUpperCase() ;

		const msg = args.length === 1 && typeof args[ 0 ] === "string"
			? args[ 0 ]
			: args.map( a => typeof a === "string" ? a : JSON.stringify( a ) ).join( " " ) ;

		try
		{
			appendFileSync( LOG_FILE, `[${new Date().toISOString()}] [${label}]: ${msg}\n` ) ;
		}
		catch ( _err ) { /* log write failed — non-fatal */ }
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function timestamp(): string
{
	const d = new Date() ;
	const y = d.getUTCFullYear() ;
	const m = String( d.getUTCMonth() + 1 ).padStart( 2, "0" ) ;
	const day = String( d.getUTCDate() ).padStart( 2, "0" ) ;
	const h = String( d.getUTCHours() ).padStart( 2, "0" ) ;
	const min = String( d.getUTCMinutes() ).padStart( 2, "0" ) ;
	return `${y}-${m}-${day}-${h}${min}` ;
}

interface MessageLike
{
	info: { role: "user" | "assistant" ; id?: string } ;
	parts: Array<{ type: string ; text?: string }> ;
}

function extractText( msg: MessageLike ): string
{
	if ( !msg.parts?.length ) return "" ;

	const parts = msg.parts ;
	let out = "" ;

	for ( let i = 0 ; i < parts.length ; i++ )
	{
		const p = parts[ i ] ;
		if ( p.type === "text" && typeof p.text === "string" )
		{
			out = out ? out + "\n" + p.text : p.text ;
		}
	}

	return out.trim() ;
}

interface NoteBullet
{
	role: "user" | "assistant" ;
	text: string ;
}

interface ExtractedNotes
{
	task: NoteBullet[] ;
	decisions: NoteBullet[] ;
	nextSteps: NoteBullet[] ;
}

const NOTE_HEADERS = {
	task: /^##\s+Task\b/m ,
	decisions: /^##\s+Decisions\b/m ,
	nextSteps: /^##\s+Next\s+steps\b/m ,
} as const ;

function extractNotes( text: string, role: "user" | "assistant" ): ExtractedNotes
{
	const out: ExtractedNotes = { task: [], decisions: [], nextSteps: [] } ;

	const sections: Array<{ key: keyof ExtractedNotes ; start: number }> = [] ;
	for ( const [ key, re ] of Object.entries( NOTE_HEADERS ) as Array<[ keyof ExtractedNotes, RegExp]> )
	{
		const m = text.match( re ) ;
		if ( m?.index !== undefined ) sections.push( { key, start: m.index + m[ 0 ].length } ) ;
	}

	sections.sort( ( a, b ) => a.start - b.start ) ;

	for ( let i = 0 ; i < sections.length ; i++ )
	{
		const cur = sections[ i ] ;
		const end = sections[ i + 1 ]?.start ?? text.length ;
		const body = text.slice( cur.start, end ).trim() ;

		const bullets = body
			.split( "\n" )
			.map( l => l.trim() )
			.filter( l => l.startsWith( "- " ) || l.startsWith( "* " ) )
			.map( l => l.slice( 2 ).trim() )
			.filter( Boolean ) ;

		for ( const b of bullets ) out[ cur.key ].push( { role, text: b } ) ;
	}

	return out ;
}

function listHandoffFiles( dir: string ): string[]
{
	if ( !existsSync( dir ) ) return [] ;
	return readdirSync( dir, { withFileTypes: true } )
		.filter( d => d.isFile() && d.name.endsWith( ".md" ) )
		.map( d => d.name )
		.sort() ;
}

function rotateHandoffFiles( dir: string, maxStored: number ): void
{
	const files = listHandoffFiles( dir ) ;
	if ( files.length <= maxStored ) return ;

	const excess = files.length - maxStored ;
	for ( let i = 0 ; i < excess ; i++ )
	{
		try { unlinkSync( join( dir, files[ i ] ) ) ; }
		catch ( _err ) { /* non-fatal */ }
	}
}

function sliceKeepLast( text: string, n: number ): string
{
	const lines = text.split( "\n" ) ;
	const headerIdx = lines.findIndex( l => l.startsWith( "## Recent messages" ) ) ;
	if ( headerIdx === -1 ) return text ;

	const headerEnd = headerIdx + 2 ;
	const body = lines.slice( headerEnd, headerEnd + n ) ;
	return [ ...lines.slice( 0, headerEnd ), ...body ].join( "\n" ) ;
}

// ─── Templates ─────────────────────────────────────────────────────────────

const readTemplate = ( handoff: string ): string =>
	`## Resume previous session — handoff loaded\n\n` +
	`A handoff from a previous session was loaded. ` +
	`Read it and present a structured markdown summary with these sections:\n\n` +
	`- **Where we left off** — last task/state\n` +
	`- **Key context** — files, decisions, constraints\n` +
	`- **Next step** — what was pending\n\n` +
	`Pay special attention to the \`## Task\`, \`## Decisions\`, and \`## Next steps\` ` +
	`sections — they are explicit notes from the previous session and take priority ` +
	`over inferred context from the recent messages.\n\n` +
	`---\n\n` +
	`${handoff}` +
	`\n\n---` ;

const writeTemplate = (
	ts: string,
	reason: string,
	recentCount: number,
	messagesBlock: string,
	notes: ExtractedNotes,
): string =>
{
	const sections: string[] = [
		`# Handoff — ${ts}`,
		`## Reason\n${reason}`,
	] ;

	const render = ( bullets: NoteBullet[] ): string =>
		bullets.map( b => `- [${b.role}] ${b.text}` ).join( "\n" ) ;

	if ( notes.task.length > 0 )
		sections.push( `## Task\n${render( notes.task )}` ) ;

	if ( notes.decisions.length > 0 )
		sections.push( `## Decisions\n${render( notes.decisions )}` ) ;

	if ( notes.nextSteps.length > 0 )
		sections.push( `## Next steps\n${render( notes.nextSteps )}` ) ;

	sections.push( `## Recent messages (last ${recentCount})\n${messagesBlock}` ) ;

	return sections.join( "\n\n" ) + "\n" ;
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( ctx: PluginInput, rawOptions?: PluginOptions ) =>
{
	const opts = mergeOptions( loadConfig(), rawOptions ) ;
	const logger = new Logger( opts.log_level ) ;
	const projectDir = ctx.directory ;

	const messages: Array<{ role: string ; content: string }> = [] ;
	const notes: ExtractedNotes = { task: [], decisions: [], nextSteps: [] } ;
	let lastSeenMessageId: string | null = null ;

	let lastWriteTime = 0 ;
	let pendingHandoff: string | null = null ;
	let handoffInjected = false ;

	const writeHandoff = ( reason: string ): void =>
	{
		try
		{
			const ts = timestamp() ;
			const dir = join( projectDir, ".handoff" ) ;
			const path = join( dir, `${ts}.md` ) ;

			const recent = messages.slice( -opts.keep_last ) ;

			const messagesBlock = recent.length > 0
				? recent.map( m => `- [${m.role}] ${m.content.slice( 0, 200 )}` ).join( "\n" )
				: "(no messages captured)" ;

			const content = writeTemplate( ts, reason, recent.length, messagesBlock, notes ) ;

			mkdirSync( dir, { recursive: true } ) ;
			writeFileSync( path, content ) ;

			rotateHandoffFiles( dir, opts.max_stored_files ) ;

			lastWriteTime = Date.now() ;

			logger.log( "info", `Handoff written (${reason}): ${path}` ) ;
		}
		catch ( err )
		{
			logger.log( "error", "write failed:", ( err as Error ).message ) ;
		}
	} ;

	const onExit = (): void =>
	{
		if ( !opts.on_exit ) return ;
		if ( Date.now() - lastWriteTime < 5000 ) return ;

		try { writeHandoff( "exit" ) ; } catch ( _err ) { /* non-fatal */ }
	} ;

	process.once( "exit", onExit ) ;

	if ( opts.on_start )
	{
		try
		{
			const dir = join( projectDir, ".handoff" ) ;

			const files = listHandoffFiles( dir ) ;
			const loadCount = Math.min( opts.max_load_files, files.length ) ;

			if ( loadCount > 0 )
			{
				const selected = files.slice( -loadCount ) ;
				const stack = selected
					.map( f => readFileSync( join( dir, f ), "utf8" ) )
					.join( "\n\n---\n\n" ) ;

				pendingHandoff = sliceKeepLast( stack, opts.keep_last ) ;
				logger.log( "info", `Handoff loaded: ${loadCount} file(s), sliced to ${opts.keep_last} entries` ) ;
			}
		}
		catch ( err )
		{
			logger.log( "error", "on_start load failed:", ( err as Error ).message ) ;
		}
	}

	logger.log( "info", `Initialized | project: ${projectDir} | cfg: ${JSON.stringify( opts )}` ) ;

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
					} as MessageLike ) ;

					handoffInjected = true ;
					messages.length = 0 ;

					logger.log( "info", "Handoff injected into context" ) ;
				}

				if ( !output.messages?.length ) return ;

				for ( const msg of output.messages )
				{
					if ( msg.info.role === "user" && msg.info.id === "handoff-resume" ) continue ;
					if ( msg.info.id && msg.info.id <= ( lastSeenMessageId ?? "" ) ) continue ;

					const text = extractText( msg as MessageLike ) ;
					if ( !text ) continue ;

					const last = messages[ messages.length - 1 ] ;
					if ( last && last.content === text ) continue ;

					messages.push( { role: msg.info.role, content: text } ) ;
					if ( msg.info.id ) lastSeenMessageId = msg.info.id ;

					const role = msg.info.role === "assistant" ? "assistant" : "user" ;
					const extracted = extractNotes( text, role ) ;
					for ( const key of [ "task", "decisions", "nextSteps" ] as const )
					{
						for ( const bullet of extracted[ key ] )
						{
							const dup = notes[ key ].some( n => n.text === bullet.text && n.role === bullet.role ) ;
							if ( !dup ) notes[ key ].push( bullet ) ;
						}
					}
				}

				if ( opts.every_turns > 0 && messages.length >= opts.every_turns )
				{
					writeHandoff( `periodic (${messages.length} messages)` ) ;
					messages.length = 0 ;
					notes.task = [] ;
					notes.decisions = [] ;
					notes.nextSteps = [] ;
				}
			}
			catch ( err )
			{
				logger.log( "error", "messages.transform:", ( err as Error ).message ) ;
			}
		},

		dispose: async () =>
		{
			process.removeListener( "exit", onExit ) ;

			if ( opts.on_exit )
			{
				try { writeHandoff( "dispose" ) ; } catch ( _err ) { /* non-fatal */ }
			}
			logger.log( "info", "Disposed" ) ;
		},
	} ;
} ) satisfies Plugin ;
