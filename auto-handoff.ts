/**
*	auto-handoff.ts
*
*	OpenCode plugin — periodic + exit handoff writer, startup handoff reader.
*	Writes .handoff/<timestamp>.md every N messages (user + assistant) and on session exit.
*	Loads handoffs on startup. No keywords, no database.
*
*	Install: cp auto-handoff.ts ~/.config/opencode/plugins/auto-handoff.ts
*	Config:  ~/.config/opencode/auto-handoff.jsonc
*	Log:     ~/.config/opencode/auto-handoff.log
*	Output: <project>/.handoff/<timestamp>.md
*
*	@example ~/.config/opencode/auto-handoff.jsonc
*	{
*		"every_messages": 20,   // trigger periodic write every N messages (0 = never)
*		"on_exit": true,        // write handoff on dispose/exit
*		"on_start": true,       // load recent handoffs on startup
*		"keep_last": 20,        // max messages per handoff (write & load)
*		"max_stored_files": 10, // max .handoff/*.md files to keep (rotation)
*		"max_load_files": 5,    // max recent handoff files to load on startup
*		"log_level": "info",    // silent, error, info, debug
*	}
*
*	@name auto-handoff plugin.
*	@version 1.1.1
*	@author Alejandro Carraretto
*	@author MiniMax-M3
*	@license MIT
*/

import type { Plugin, PluginInput } from "@opencode-ai/plugin" ;
import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "auto-handoff.jsonc" ) ;
const LOG_FILE    = join( CONFIG_DIR, "auto-handoff.log" ) ;

// ─── Constants ─────────────────────────────────────────────────────────────

const LOG_LEVEL =
{
	SILENT : 0,
	ERROR  : 1,
	INFO   : 2,
	DEBUG  : 3,
} as const ;

const CONFIG =
{
	every_messages: 20,      // trigger periodic write every N messages (0 = never)
	on_exit: true,           // write handoff on dispose/exit
	on_start: true,          // load recent handoffs on startup
	keep_last: 20,           // max messages per handoff (write & load)
	max_stored_files: 10,    // max .handoff/*.md files to keep (rotation)
	max_load_files: 5,       // max recent handoff files to load on startup
	log_level: "info" as "silent" | "error" | "info" | "debug",
};

const STRIP_PATTERNS =
[
	"<system[^>]*>[\\s\\S]*?</system[^>]*>",
	"<env[^>]*>[\\s\\S]*?</env[^>]*>",
	"<think[^>]*>[\\s\\S]*?</think[^>]*>",
	"<tool_[^>]*>[\\s\\S]*?</tool_[^>]*>",
	"<mcp_[^>]*>[\\s\\S]*?</mcp_[^>]*>",
	"<dcp-[^>]*>[\\s\\S]*?</dcp-[^>]*>",
	"<conver[^>]*>[\\s\\S]*?</conver[^>]*>",
	"<temp[^>]*>[\\s\\S]*?</temp[^>]*>",
	"<available_[^>]*>[\\s\\S]*?</available_[^>]*>",
	"<prev[^>]*>[\\s\\S]*?</prev[^>]*>",
	"<handoff[^>]*>[\\s\\S]*?</handoff[^>]*>",
	"<deep-[^>]*>[\\s\\S]*?</deep-[^>]*>",
	"\\[Tool output truncated[\\s\\S]*",
	"\\[Old tool result[\\s\\S]*",
	"▣\\s*(?:DCP|Compression)[\\s\\S]*",
	"\\[Compressed[\\s\\S]*",
];

// ─── Interfaces ────────────────────────────────────────────────────────────

interface MessageLike
{
	info: { role: "user" | "assistant"; id?: string; sessionID?: string } ;
	parts: Array<{ type: string; text?: string }> ;
}

interface MessageEntry
{
	role: "user" | "assistant" ;
	content: string ;
}

// ─── Config ────────────────────────────────────────────────────────────────

// Load config from ~/.config/opencode/auto-handoff.jsonc, fall back to defaults
function loadConfig(): typeof CONFIG
{
	let file : Record<string, unknown> = {} ;
	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf8" ) ) ;
		log( LOG_LEVEL.INFO, "Config loaded" ) ;
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
	}

	const opts =
	{
		every_messages:    Math.max( 0, file.every_messages   ?? file.every_turns       ?? CONFIG.every_messages ),
		on_exit:           file.on_exit                       ?? CONFIG.on_exit           ,
		on_start:          file.on_start                      ?? CONFIG.on_start          ,
		keep_last:         Math.max( 1, file.keep_last        ?? CONFIG.keep_last        ),
		max_stored_files:  Math.max( 1, file.max_stored_files ?? CONFIG.max_stored_files ),
		max_load_files:    Math.max( 1, file.max_load_files   ?? CONFIG.max_load_files   ),
		log_level:         file.log_level                     ?? CONFIG.log_level         ,
	} as typeof CONFIG;

	CONFIG.log_level = opts.log_level ;

	return opts ;
}

// ─── Logger ────────────────────────────────────────────────────────────────

// Append timestamped entry to ~/.config/opencode/auto-handoff.log
function log( level : number, message : string ) : void
{
	const min = LOG_LEVEL[ ( CONFIG.log_level ?? "info" ).toUpperCase() ] ?? LOG_LEVEL.ERROR ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ?? "" ;

	try
	{
		appendFileSync( LOG_FILE, `[${ new Date().toISOString() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// Generate timestamp for handoff filenames: "2026-07-06-203026" (system local time)
function timestamp(): string
{
	const d      = new Date() ;
	const offset = d.getTimezoneOffset() ;
	const local  = new Date( d.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ).replace( 'T', '-' ).replace( /:/g, '' ) ;
}

const isValidRole = ( role: string ): boolean =>
	["user", "assistant"].includes( role );


// Extract plain text from a MessageLike, stripping system tags and compress artifacts
const extractText = ( msg: MessageLike ): string =>
{
	const text = ( msg.parts ?? [] )
		.filter( p => p.type === "text" && typeof p.text === "string" )
		.map( p => p.text! )
		.join( "\n" ) ;

	return text.replace( new RegExp( STRIP_PATTERNS.join( "|" ), "gi" ), "" ).trim() ;
};

// ─── Parsers ───────────────────────────────────────────────────────────────

// Parse .md handoff content into structured message entries
const parseFeedback = ( content: string ): MessageEntry[] =>
{
	const lines = content.split( "\n" ) ;
	const entries: MessageEntry[] = [] ;
	let current: MessageEntry | null = null ;

	for ( const line of lines )
	{
		const match = line.match( /^\s*-\s*\[(user|assistant)\]\s*(.*)/ ) ;

		if ( match )
		{
			current = { role: match[ 1 ], content: match[ 2 ] } ;
			entries.push( current ) ;
		}
		else if ( current )
		{
			current.content += "\n" + line ;
		}
	}

	return entries ;
};

// List .md files in directory, sorted by filename (oldest first)
const listHandoffFiles = ( dir: string ): string[] =>
	existsSync( dir )
		? readdirSync( dir ).filter( f => f.endsWith( ".md" ) ).sort()
		: [] ;

// Remove oldest .md files when count exceeds maxStored (FIFO rotation)
const rotateHandoffFiles = ( dir: string, maxStored: number ): void =>
{
	const files = listHandoffFiles( dir );
	const excess = files.length - maxStored ;

	if ( excess <= 0 ) return ;

	files.slice( 0, excess ).forEach( f =>
	{
		try { unlinkSync( join( dir, f ) ); } catch { /* non-fatal */ }
	} );
};

// ─── Builders ──────────────────────────────────────────────────────────────

// Build <handoff-resume> injection from message entries
const buildInjection = ( entries: MessageEntry[] ): string =>
{
	const block = entries
		.map( e => `- [${e.role}] ${e.content}` )
		.join( "\n" );

	return (
		`<handoff-resume>\n\n` +
		`# ⚠️ HARD RULE — read this first\n\n` +
		`The feedback records below are your **only** source of truth for previous session state.\n\n` +
		`## 🚫 PROHIBITED — doing any of these is a **bug**, not a mistake\n\n` +
		`- Do NOT run \`readdir\`, \`readFile\`, \`glob\`, or \`grep\` on \`.handoff/\`\n` +
		`- Do NOT run \`git log\`, \`git diff\`, \`git status\`, or any git inspection command\n` +
		`- Do NOT re-read any project file to "verify" what the handoff already tells you\n\n` +
		`If you do any of the above, you have **failed this turn** — the handoff is authoritative.\n\n` +
		`## ✅ What to do instead\n\n` +
		`Synthesize directly from the feedback records below. Present a clear, structured markdown summary covering:\n` +
		`- **Where we left off** — last task and current state\n` +
		`- **Key context** — files touched, decisions made, constraints discovered\n` +
		`- **Next step** — what was pending or in progress\n` +
		`- **Load skills** — load the prefixed skills\n\n` +
		`## Feedback records\n\n` +
		`${block}` +
		`\n\n</handoff-resume>`
	);
};

// Build .md file content from message entries
const buildFileContent = ( ts: string, reason: string, entries: MessageEntry[], keepLast: number ): string =>
{
	const recent = entries.slice( -keepLast );
	const block = recent.length > 0
		? recent.map( e => `- [${e.role}] ${e.content}` ).join( "\n" )
		: "(no messages captured)" ;

	return (
		`# Handoff — ${ts}\n\n` +
		`## Reason\n${reason}\n\n` +
		`${block}\n`
	);
};

// ─── AutoHandoff ───────────────────────────────────────────────────────────

class AutoHandoff
{
	private opts       : typeof CONFIG ;
	private projectDir : string ;
	private handoffDir : string ;
	private client     : PluginInput[ "client" ] ;

	private messages         : MessageEntry[]  = [] ;
	private seenMessageIds   : Set<string>     = new Set() ;
	private currentSessionID : string | null   = null ;
	private pendingHandoff   : MessageEntry[]  | null ;

	private _boundOnExit : () => void ;

	constructor( opts: typeof CONFIG, projectDir: string, client: PluginInput[ "client" ] )
	{
		this.opts       = opts ;
		this.projectDir = projectDir ;
		this.handoffDir = join( projectDir, ".handoff" ) ;
		this.client     = client ;

		this._boundOnExit = () => this.onExit() ;
		process.once( "exit", this._boundOnExit ) ;

		this.pendingHandoff = this.loadHandoffs() ;
	}

	// ── Private helpers ───────────────────────────────────────────────────

	private flushMessages(): void
	{
		this.messages.length = 0 ;
	}

	private isDedup( role: string, content: string ): boolean
	{
		const last = this.messages[ this.messages.length - 1 ] ;
		return ( !!last && last.role === role && last.content === content ) ;
	}

	private isHandoffResume( msg: MessageLike ): boolean
	{
		return ( msg.info.role === "user" && msg.info.id === "handoff-resume" ) ;
	}

	private isAlreadySeen( msg: MessageLike ): boolean
	{
		return ( !!msg.info.id && this.seenMessageIds.has( msg.info.id ) ) ;
	}

	private shouldWritePeriodic(): boolean
	{
		return ( this.opts.every_messages > 0 && this.messages.length >= this.opts.every_messages ) ;
	}

	private writeHandoff( reason: string, entries: MessageEntry[] = this.messages ): void
	{
		if ( entries.length <= 0 )
		{
			log( LOG_LEVEL.DEBUG, `Handoff skipped (no messages): ${reason}` ) ;
			return ;
		}
		try
		{
			const ts = timestamp() ;
			const path = join( this.handoffDir, `${ts}.md` ) ;
			const content = buildFileContent( ts, reason, entries, this.opts.keep_last ) ;

			mkdirSync( this.handoffDir, { recursive: true } ) ;
			writeFileSync( path, content ) ;

			rotateHandoffFiles( this.handoffDir, this.opts.max_stored_files ) ;

			log( LOG_LEVEL.INFO, `Handoff written: ${reason}: ${path}` ) ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `write failed: ${( err as Error ).message}` ) ;
		}
	}

	private onExit(): void
	{
		if ( !this.opts.on_exit ) return ;

		try
		{
			this.writeHandoff( `exit (${this.messages.length} messages)` ) ;
			this.flushMessages() ;
		}
		catch { /* non-fatal */ }
	}

	private loadHandoffs(): MessageEntry[] | null
	{
		if ( !this.opts.on_start ) return null ;

		try
		{
			const files = listHandoffFiles( this.handoffDir ) ;
			const loadCount = Math.min( this.opts.max_load_files, files.length ) ;

			if ( loadCount === 0 ) return null ;

			const entries = files.slice( -loadCount )
				.flatMap( f => parseFeedback( readFileSync( join( this.handoffDir, f ), "utf8" ) ) )
				.slice( -this.opts.keep_last ) ;

			log( LOG_LEVEL.INFO, `Handoff loaded: ${loadCount} file(s), ${entries.length} messages` ) ;
			return entries ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `on_start load failed: ${( err as Error ).message}` ) ;
			return null ;
		}
	}

	private async fetchLastMessage( sessionID: string ): Promise<MessageEntry | null>
	{
		try
		{
			const result = await this.client.session.messages( {
				path  : { id : sessionID } ,
				query : { limit : 1 } ,
			} ) ;

			const msg = result?.data?.[ 0 ] ;
			if ( !msg ) return null ;

			const text = extractText( msg as MessageLike ) ;
			if ( !text ) return null ;

			return { role : msg.info.role, content : text } ;
		}
		catch
		{
			log( LOG_LEVEL.ERROR, `fetchLastMessage failed` ) ;
			return null ;
		}
	}

	private injectHandoff( output: { messages?: MessageLike[] } ): boolean
	{
		if ( this.pendingHandoff === null || !output.messages?.length ) return true ;

		const injection = buildInjection( this.pendingHandoff ) ;

		output.messages.unshift( {
			info: { role: "user", id: "handoff-resume" },
			parts: [ { type: "text", text: injection } ],
		} as MessageLike );

		log( LOG_LEVEL.INFO, `Handoff injected: ${this.pendingHandoff.length} messages, ${injection.length} bytes` ) ;

		if ( CONFIG.log_level === "debug" )
		{
			writeFileSync( join( this.projectDir, "handoff-resume.txt" ), injection ) ;
			log( LOG_LEVEL.DEBUG, `handoff-resume.txt written` ) ;
		}

		this.pendingHandoff = null ;
		this.flushMessages() ;

		return true ;
	}

	// ── Public hooks ──────────────────────────────────────────────────────

	public async transform( _input: unknown, output: { messages?: MessageLike[] } ): Promise<void>
	{
		try
		{
			if ( !this.injectHandoff( output ) ) return ;
			if ( !output.messages?.length ) return ;

			for ( const msg of output.messages )
			{
				if ( this.isHandoffResume( msg ) ) continue ;
				if ( this.isAlreadySeen( msg ) ) continue ;
				if ( !isValidRole( msg.info.role ) ) continue ;

				if ( msg.info?.sessionID ) this.currentSessionID = msg.info.sessionID ;

				const text = extractText( msg as MessageLike ) ;
				if ( !text ) continue ;

				if ( this.isDedup( msg.info.role, text ) ) continue ;

				this.messages.push( { role: msg.info.role, content: text } ) ;

				if ( msg.info.id ) this.seenMessageIds.add( msg.info.id ) ;
			}

			if ( this.shouldWritePeriodic() )
			{
				this.writeHandoff( `periodic (${this.messages.length} messages)` ) ;
				this.flushMessages() ;
			}
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `messages.transform: ${( err as Error ).message}` ) ;
		}
	}

	public async dispose(): Promise<void>
	{
		if ( this.opts.on_exit )
		{
			try
			{
				if ( this.currentSessionID )
				{
					const last = await this.fetchLastMessage( this.currentSessionID ) ;
					if ( last && !this.isDedup( last.role, last.content ) ) this.messages.push( last ) ;
				}

				if ( this.messages.length > 0 )
				{
					this.writeHandoff( `dispose (${this.messages.length} messages)`, this.messages ) ;
				}

				this.flushMessages() ;
			}
			catch { /* non-fatal */ }
		}

		process.removeListener( "exit", this._boundOnExit ) ;
		log( LOG_LEVEL.INFO, "Disposed" ) ;
	}
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( ctx: PluginInput ) =>
{
	const opts = loadConfig() ;
	const ah = new AutoHandoff( opts, ctx.directory, ctx.client ) ;

	log( LOG_LEVEL.INFO, `Initialized | project: ${ctx.directory}` ) ;

	return {
		"experimental.chat.messages.transform": ( i: unknown, o: { messages?: MessageLike[] } ) => ah.transform( i, o ),
		dispose: () => ah.dispose(),
	};
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
