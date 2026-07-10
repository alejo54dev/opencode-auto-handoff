/**
*	auto-handoff.ts
*
*	OpenCode plugin — periodic + exit handoff writer, startup handoff reader.
 *	Circular buffer (window_size) writes .handoff/<timestamp>.md on cycle (if periodic) and on session exit.
*	Loads handoffs on startup. No keywords, no database.
*
*	Install: cp auto-handoff.ts ~/.config/opencode/plugins/auto-handoff.ts
*	Config:  ~/.config/opencode/auto-handoff.jsonc
*	Log:     ~/.config/opencode/auto-handoff.log
*	Output: <project>/.handoff/<timestamp>.md
*
*	@example ~/.config/opencode/auto-handoff.jsonc
*	{
*		"enabled": true,           // master switch
*		"on_exit": true,           // write handoff on dispose/exit
*		"on_start": true,          // load recent handoffs on startup
*		"window_size": 20,         // max buffer size; cycles when full, writes if periodic
*		"periodic": true,          // write .md file on every buffer cycle
*		"max_stored_files": 50,    // max .handoff/*.md files to keep (rotation)
*		"max_load_files": 5,       // max recent handoff files to load on startup
*		"log_level": "info",       // silent, error, info, debug
*	}
*
*	@name auto-handoff plugin.
*	@version 1.1.7
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
	enabled: true,           // master switch
	on_exit: true,           // write handoff on dispose/exit
	on_start: true,          // load recent handoffs on startup
	window_size: 20,         // max buffer size; cycles when full, writes if periodic
	periodic: true,          // write .md file on every buffer cycle
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

// ─── Global Helpers ──────────────────────────────────────────────────────────

// Current local datetime as ISO-like string: "2026-07-06T20:30:26"
function timestamp() : string
{
	const utc    = new Date() ;
	const offset = utc.getTimezoneOffset() ;
	const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ) ;
}

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
		enabled:           file.enabled                       ?? CONFIG.enabled           ,
		on_exit:           file.on_exit                       ?? CONFIG.on_exit           ,
		on_start:          file.on_start                      ?? CONFIG.on_start          ,
		window_size:       Math.max( 1, file.window_size      ?? CONFIG.window_size      ),
		periodic:          file.periodic                      ?? CONFIG.periodic          ,
		max_stored_files:  Math.max( 1, file.max_stored_files ?? CONFIG.max_stored_files ),
		max_load_files:    Math.max( 1, file.max_load_files   ?? CONFIG.max_load_files   ),
		log_level:         file.log_level                     ?? CONFIG.log_level         ,
	} as typeof CONFIG;

	CONFIG.log_level = opts.log_level ;

	return opts ;
}

// Append timestamped entry to ~/.config/opencode/auto-handoff.log
function log( level : number, message : string ) : void
{
	const min = LOG_LEVEL[ ( CONFIG.log_level ?? "info" ).toUpperCase() ] ?? LOG_LEVEL.ERROR ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ?? "" ;

	try
	{
		appendFileSync( LOG_FILE, `[${ timestamp() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// Generate timestamp for handoff filenames: "2026-07-06-203026" (system local time)
function fileTimestamp(): string
{
	const utc    = new Date() ;
	const offset = utc.getTimezoneOffset() ;
	const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ).replace( 'T', '-' ).replace( /:/g, '' ) ;
}

// Only valid role
const isValidRole = ( role: string ): boolean =>
{
	return [ "user", "assistant" ].includes( role ) ;
};


// Extract plain text from a MessageLike, stripping system tags and compress artifacts
const extractText = ( msg: MessageLike ): string =>
{
	const text: string[] = [] ;
	const parts = msg.parts ?? [] ;

	for ( const part of parts )
	{
		if ( part.type === "text" )
			text.push( part.text! ) ;
	}

	return text.join( "\n" ).replace( new RegExp( STRIP_PATTERNS.join( "|" ), "gi" ), "" ).trim() ;
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
		"<handoff-resume>\n" +

		"# Generate a handoff summary from the previous session\n" +
		"- The session data is inside the <feedback> tags below\n\n" +

		"# Synthesize the session data on this markdown template:\n" +
		"- **Where we left off**: [last task + current state]\n" +
		"- **Key context**: [files, decisions, constraints]\n" +
		"- **Next step**: [pending work]\n" +
		"- **Blocks**: [blockers or issues]\n" +
		"- **Notes**: [other relevant info]\n\n" +

		"# Handoff feedback block\n" +
		"<feedback>\n" + block + "\n</feedback>\n" +

		"</handoff-resume>"
	);
// 	return (
// 		"<handoff-resume>\n\n" +
//
// 		"# Generate a handoff summary from the previous session\n" +
// 		"- Read newest 5 .md files from <PROJECT_ROOT>/.handoff/ and load in descending order\n" +
//
// 		"# Synthesize the session data on this markdown template:\n" +
// 		"- **Where we left off**: [last task + current state]\n" +
// 		"- **Key context**: [files, decisions, constraints]\n" +
// 		"- **Next step**: [pending work]\n" +
// 		"- **Blocks**: [blockers or issues]\n" +
// 		"- **Notes**: [other relevant info]\n\n" +
//
// 		"If no files: No previous session found\n" +
// 		"Use fs.readdirSync, not glob\n\n" +
//
// 		"</handoff-resume>"
// 	);
};

// Build .md file content from message entries
const buildFileContent = ( ts: string, reason: string, entries: MessageEntry[], maxEntries: number ): string =>
{
	const recent = entries.slice( -maxEntries );
	const block = recent.length
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

		this.pendingHandoff = this.opts.on_start ? this.loadHandoffs() : null ;
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
		return ( this.opts.periodic && ( this.messages.length >= this.opts.window_size ) ) ;
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
			const ts = fileTimestamp() ;
			const path = join( this.handoffDir, `${ts}.md` ) ;
			const content = buildFileContent( ts, reason, entries, this.opts.window_size ) ;

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
		try
		{
			const files = listHandoffFiles( this.handoffDir ) ;
			const loadCount = Math.min( this.opts.max_load_files, files.length ) ;

			if ( !loadCount ) return null ;

			const entries = files.slice( -loadCount )
				.flatMap( f => parseFeedback( readFileSync( join( this.handoffDir, f ), "utf8" ) ) )
				.slice( -this.opts.window_size ) ;

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
		if ( this.pendingHandoff === null ) return false ;

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

	public async transform( output: { messages?: MessageLike[] } ): Promise<void>
	{
		try
		{
			if ( this.opts.on_start ) // on_start !!
				this.injectHandoff( output ) ;

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

				if ( this.messages.length )
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

	if ( !opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	const ah = new AutoHandoff( opts, ctx.directory, ctx.client ) ;

	log( LOG_LEVEL.INFO, `Initialized | project: ${ctx.directory}` ) ;

	return {
		"experimental.chat.messages.transform": async ( input: unknown, output: { messages?: MessageLike[] } ) =>
		{
			ah.transform( output ) ;
		},
		dispose: () => ah.dispose(),
	};
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
