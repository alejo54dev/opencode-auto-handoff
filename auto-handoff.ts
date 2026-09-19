/**
*	auto-handoff.ts
*
*	OpenCode plugin — periodic + exit handoff writer, startup handoff reader.
*	Circular buffer (window_size) writes .handoff/<timestamp>.md on cycle (if save_periodic) and on session exit.
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
*		"window_size": 20,         // max buffer size; cycles when full, save if periodic
*		"load_on_start": true,     // load recent handoffs on startup
*		"max_load_files": 5,       // max recent handoff files to load on startup
*		"save_periodic": true,     // write handoff file on every buffer cycle
*		"save_on_exit": true,      // write handoff file on dispose/exit
*		"max_stored_files": 50,    // max .handoff/*.md files to keep (rotation)
*		"log_level": "info",       // silent, error, info, debug
*	}
*
*	@name auto-handoff plugin.
*	@version 1.1.23
*	@author Alejandro Carraretto
*	@assistant MiniMax-M3
*	@license AGPL-3.0
*	@compatibility OpenCode v1
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

const CONFIG : Config =
{
	enabled          : true, // master switch
	window_size      : 20,   // max buffer size; cycles when full, save if periodic
	load_on_start    : true, // load recent handoffs on startup
	max_load_files   : 5,    // max recent handoff files to load on startup
	save_periodic    : true, // write handoff file on every buffer cycle
	save_on_exit     : true, // write handoff file on dispose/exit
	max_stored_files : 50,   // max .handoff/*.md files to keep (rotation)
	log_level        : "info",
};

// Optional/additional chat content filter. (empty by default)
const FILTER_PATTERNS =
[
	// Reference: https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/blob/master/lib/messages/utils.ts
	/<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi,
	/<\/?dcp[^>]*>/gi,
	/\[Tool output truncated/gi,
	/\[Old tool result/gi,
	/▣\s*(?:DCP|Compression)[\s\S]*/gi,
	/\[Compressed[\s\S]*/gi,
];

// ─── Interfaces ────────────────────────────────────────────────────────────

interface Config
{
	enabled          : boolean ;
	window_size      : number ;
	load_on_start    : boolean ;
	max_load_files   : number ;
	save_periodic    : boolean ;
	save_on_exit     : boolean ;
	max_stored_files : number ;
	log_level        : "silent" | "error" | "info" | "debug" ;
}

interface MessageLike
{
	info: { role : "user" | "assistant"; id? : string; sessionID? : string; summary? : boolean } ;
	parts: Array<{ type : string; text? : string; synthetic? : boolean; ignored? : boolean }> ;
}

interface MessageEntry
{
	role: "user" | "assistant" ;
	content : string ;
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
function loadConfig() : Config
{
	let file : Partial<Config> = {} ;
	let loaded = false ;

	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf8" ) ) as Partial<Config> ;
		loaded = true ;
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
	}

	Object.assign( CONFIG, file ) ;

	CONFIG.window_size      = Math.max( 1, CONFIG.window_size ) ;
	CONFIG.max_stored_files = Math.max( 1, CONFIG.max_stored_files ) ;
	CONFIG.max_load_files   = Math.max( 1, CONFIG.max_load_files ) ;

	log( LOG_LEVEL.INFO, loaded ? "Config loaded" : "Config loaded (defaults)" ) ;

	return CONFIG ;
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

// ─── AutoHandoff ───────────────────────────────────────────────────────────

class AutoHandoff
{
	private config     : Config ;
	private projectDir : string ;
	private handoffDir : string ;
	private client     : PluginInput[ "client" ] ;

	private messages         : MessageEntry[]  = [] ;
	private seenMessageIds   : Set<string>     = new Set() ;
	private currentSessionID : string | null   = null ;
	private pendingHandoff   : MessageEntry[]  | null ;

	private _boundOnExit : () => void ;

	// Initialize plugin: bind exit listener, load handoffs if load_on_start
	constructor( config : Config, projectDir : string, client : PluginInput[ "client" ] )
	{
		this.config     = config ;
		this.projectDir = projectDir ;
		this.handoffDir = join( projectDir, ".handoff" ) ;
		this.client     = client ;

		this._boundOnExit = () => this.onExit() ;
		process.once( "exit", this._boundOnExit ) ;

		this.pendingHandoff = this.config.load_on_start ? this.loadHandoffs() : null ;
	}

	// Clear the in-memory message buffer
	protected flushMessages() : void
	{
		this.messages.length = 0 ;
	}

	// True if last buffered message matches role+content (dedup guard)
	protected isDedup( role : string, content : string ) : boolean
	{
		const last = this.messages[ this.messages.length - 1 ] ;
		return ( !! last && last.role === role && last.content === content ) ;
	}

	// True if message is the injected <handoff-resume> (skip re-capture)
	protected isHandoffResume( msg : MessageLike ) : boolean
	{
		return ( msg.info.role === "user" && msg.info.id === "handoff-resume" ) ;
	}

	// True if message id already tracked in seenMessageIds
	protected isAlreadySeen( msg : MessageLike ) : boolean
	{
		return ( !! msg.info.id && this.seenMessageIds.has( msg.info.id ) ) ;
	}

	// True if part is runtime-injected (non-text, synthetic, ignored) or belongs
	// to a compaction checkpoint (summary message) — state, not conversation
	protected isRuntime( p : { type : string; synthetic? : boolean; ignored? : boolean }, info : { summary? : boolean } ) : boolean
	{
		const is = ( info.summary === true || p.type != "text" || p.synthetic == true || p.ignored == true ) ;

		if ( is )
			log( LOG_LEVEL.DEBUG, `Runtime part: type=${p.type} synthetic=${p.synthetic} ignored=${p.ignored} summary=${info.summary}` ) ;

		return is ;
	}

	// Extract plain text from a message, stripping runtime parts and noise tags
	protected extractText( message : MessageLike ) : string
	{
		const chunks : string[] = [] ;
		const parts = message.parts ?? [] ;

		for ( const part of parts )
		{
			if ( this.isRuntime( part, message.info ) ) continue ;
			if ( part.text ) chunks.push( part.text ) ;
		}

		let text = chunks.join( "\n" ) ;

		for ( const pattern of FILTER_PATTERNS )
			text = text.replace( pattern, "" ) ;

		return text.trim() ;
	}

	// Parse a .md handoff file into MessageEntry[] (role + content lines)
	protected parseFeedback( content : string ) : MessageEntry[]
	{
		const lines = content.split( "\n" ) ;
		const entries : MessageEntry[] = [] ;
		let current : MessageEntry | null = null ;

		for ( const line of lines )
		{
			const match = line.match( /^\s*-\s*\[(user|assistant)\]\s*(.*)/ ) ;

			if ( match )
			{
				current = { role : match[ 1 ], content : match[ 2 ] } ;
				entries.push( current ) ;
			}
			else if ( current )
			{
				current.content += "\n" + line ;
			}
		}

		return entries ;
	}

	// List .md handoff files in dir, sorted
	protected listHandoffFiles( dir : string ) : string[]
	{
		return existsSync( dir )
			? readdirSync( dir ).filter( f => f.endsWith( ".md" ) ).sort()
			: [] ;
	}

	// Delete oldest handoff files beyond max_stored_files (FIFO)
	protected rotateHandoffFiles( dir : string, maxStored : number ) : void
	{
		const files = this.listHandoffFiles( dir ) ;
		const excess = files.length - maxStored ;

		if ( excess <= 0 ) return ;

		files.slice( 0, excess ).forEach( f =>
		{
			try { unlinkSync( join( dir, f ) ); } catch { /* non-fatal */ }
		} );
	}

	// True if role is user or assistant
	protected isValidRole( role : string ) : boolean
	{
		return [ "user", "assistant" ].includes( role ) ;
	}

	// Local timestamp as YYYY-MM-DD-HHMMSS for filenames
	protected fileTimestamp() : string
	{
		const utc    = new Date() ;
		const offset = utc.getTimezoneOffset() ;
		const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

		return local.toISOString().slice( 0, 19 ).replace( 'T', '-' ).replace( /:/g, '' ) ;
	}

	// Build the <handoff-resume> XML injected into context
	protected buildInjection( entries : MessageEntry[] ) : string
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
	}

	// Build .md handoff file content from recent entries
	protected buildFileContent( ts : string, reason : string, entries : MessageEntry[], maxEntries : number ) : string
	{
		const recent = entries.slice( -maxEntries ) ;
		const block = recent.length
			? recent.map( e => `- [${e.role}] ${e.content}` ).join( "\n" )
			: "(no messages captured)" ;

		return (
			`# Handoff — ${ts}\n\n` +
			`## Reason\n${reason}\n\n` +
			`${block}\n`
		);
	}

	// True when save_periodic and buffer reached window_size
	protected shouldWritePeriodic() : boolean
	{
		return ( this.config.save_periodic && ( this.messages.length >= this.config.window_size ) ) ;
	}

	// Write a .md handoff file (skip if empty), rotate, log
	protected writeHandoff( reason : string, entries : MessageEntry[] = this.messages ) : void
	{
		if ( entries.length <= 0 )
		{
			log( LOG_LEVEL.DEBUG, `Handoff skipped (no messages): ${reason}` ) ;
			return ;
		}
		try
		{
			const ts = this.fileTimestamp() ;
			const path = join( this.handoffDir, `${ts}.md` ) ;
			const content = this.buildFileContent( ts, reason, entries, this.config.window_size ) ;

			mkdirSync( this.handoffDir, { recursive : true } ) ;
			writeFileSync( path, content ) ;

			this.rotateHandoffFiles( this.handoffDir, this.config.max_stored_files ) ;

			log( LOG_LEVEL.INFO, `Handoff written: ${reason}: ${path}` ) ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `write failed: ${( err as Error ).message}` ) ;
		}
	}

	// Process exit handler: write handoff if save_on_exit, then flush
	protected onExit() : void
	{
		if ( ! this.config.save_on_exit ) return ;

		try
		{
			this.writeHandoff( `exit (${this.messages.length} messages)` ) ;
			this.flushMessages() ;
		}
		catch { /* non-fatal */ }
	}

	// Load recent handoff files into pendingHandoff (load_on_start)
	protected loadHandoffs() : MessageEntry[] | null
	{
		try
		{
			const files = this.listHandoffFiles( this.handoffDir ) ;
			const loadCount = Math.min( this.config.max_load_files, files.length ) ;

			if ( ! loadCount ) return null ;

			const entries = files.slice( -loadCount )
				.flatMap( f => this.parseFeedback( readFileSync( join( this.handoffDir, f ), "utf8" ) ) )
				.slice( -this.config.window_size ) ;

			log( LOG_LEVEL.INFO, `Handoff loaded: ${loadCount} file(s), ${entries.length} messages` ) ;
			return entries ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `load_on_start load failed: ${( err as Error ).message}` ) ;
			return null ;
		}
	}

	// Fetch single latest message via SDK for dispose
	protected async fetchLastMessage( sessionID : string ) : Promise<MessageEntry | null>
	{
		try
		{
			const result = await this.client.session.messages( {
				path  : { id : sessionID } ,
				query : { limit : 1 } ,
			} ) ;

			const msg = result?.data?.[ 0 ] ;
			if ( ! msg ) return null ;

			const text = this.extractText( msg as MessageLike ) ;
			if ( ! text ) return null ;

			return { role : msg.info.role, content : text } ;
		}
		catch
		{
			log( LOG_LEVEL.ERROR, `fetchLastMessage failed` ) ;
			return null ;
		}
	}

	// Inject pending handoff as synthetic <handoff-resume> user message
	protected injectHandoff( output : { messages? : MessageLike[] } ) : boolean
	{
		if ( this.pendingHandoff === null ) return false ;

		const injection = this.buildInjection( this.pendingHandoff ) ;

		output.messages.unshift( {
			info : { role : "user", id : "handoff-resume" },
			// synthetic: system-injected content; capture skips it via isRuntime()
			parts : [ { type : "text", text : injection, synthetic : true } ],
		} as MessageLike ) ;

		log( LOG_LEVEL.INFO, `Handoff injected: ${this.pendingHandoff.length} messages, ${injection.length} bytes` ) ;

		if ( this.config.log_level === "debug" )
		{
			writeFileSync( join( this.projectDir, "handoff-resume.txt" ), injection ) ;
			log( LOG_LEVEL.DEBUG, `handoff-resume.txt written` ) ;
		}

		this.pendingHandoff = null ;
		this.flushMessages() ;

		return true ;
	}

	// ── Public hooks ──────────────────────────────────────────────────────

	// Store captured messages into the handoff buffer; flush/rotate when save_periodic window reached
	public async transform( output : { messages? : MessageLike[] } ) : Promise<void>
	{
		try
		{
			if ( this.config.load_on_start ) // load_on_start !!
				this.injectHandoff( output ) ;

			if ( ! output.messages?.length ) return ;

			for ( const msg of output.messages )
			{
				if ( this.isHandoffResume( msg ) ) continue ;
				if ( this.isAlreadySeen( msg ) ) continue ;
				if ( ! this.isValidRole( msg.info.role ) ) continue ;

				if ( msg.info?.sessionID ) this.currentSessionID = msg.info.sessionID ;

				const text = this.extractText( msg as MessageLike ) ;
				if ( ! text ) continue ;

				if ( this.isDedup( msg.info.role, text ) ) continue ;

				this.messages.push( { role : msg.info.role, content : text } ) ;

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

	// Hook: fetch last message, write handoff, remove exit listener
	public async dispose() : Promise<void>
	{
		if ( this.config.save_on_exit )
		{
			try
			{
				if ( this.currentSessionID )
				{
					const last = await this.fetchLastMessage( this.currentSessionID ) ;
					if ( last && ! this.isDedup( last.role, last.content ) ) this.messages.push( last ) ;
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

// Plugin factory: load config, build AutoHandoff, register hooks
export default ( async ( ctx : PluginInput ) =>
{
	const opts = loadConfig() ;

	if ( ! opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	const ah = new AutoHandoff( opts, ctx.directory, ctx.client ) ;

	log( LOG_LEVEL.INFO, `Initialized | project: ${ctx.directory}` ) ;

	return {
		"experimental.chat.messages.transform" : async ( input : unknown, output : { messages? : MessageLike[] } ) =>
		{
			ah.transform( output ) ;
		},
		dispose : () => ah.dispose(),
	};
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
