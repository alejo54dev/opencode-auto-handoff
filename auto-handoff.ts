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
*	@version 1.0.40
*	@author Alejandro Carraretto
*	@author MiniMax-M3
*	@license MIT
*/

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin" ;
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
	let file : Record<string, unknown> = {};
	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf8" ) );
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

// Generate timestamp for handoff filenames: "2026-07-03-143022"
function timestamp(): string
{
	return new Date().toISOString().slice( 0, 19 ).replace( 'T', '-' ).replace( /:/g, '' ) ;
}

// Extract plain text from a MessageLike, stripping system tags and compress artifacts
const extractText = ( msg: MessageLike ): string =>
{
	const text = ( msg.parts ?? [] )
		.filter( p => p.type === "text" && typeof p.text === "string" )
		.map( p => p.text! )
		.join( "\n" );

	return text.replace( new RegExp( STRIP_PATTERNS.join( "|" ), "gi" ), "" ).trim() ;
};

// ─── Parsers ───────────────────────────────────────────────────────────────

// Parse .md handoff content into structured message entries
const parseFeedback = ( content: string ): MessageEntry[] =>
{
	const lines = content.split( "\n" );
	const entries: MessageEntry[] = [] ;
	let current: MessageEntry | null = null ;

	for ( const line of lines )
	{
		const match = line.match( /^\s*-\s*\[(user|assistant)\]\s*(.*)/ );

		if ( match )
		{
			current = { role: match[ 1 ], content: match[ 2 ] };
			entries.push( current );
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

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( ctx: PluginInput, rawOptions?: PluginOptions ) =>
{
	const opts = loadConfig() ;
	const projectDir = ctx.directory ;
	const handoffDir = join( projectDir, ".handoff" );

	const messages: MessageEntry[] = [] ;

	const seenMessageIds = new Set<string>() ;
	let currentSessionID: string | null = null ;

	// Clear the in-memory message buffer
	const flushMessages = (): void =>
	{
		messages.length = 0 ;
	};

	// Skip if same role+content as last message (transform re-fires with full output.messages)
	const isDedup = ( role: string, content: string ): boolean =>
	{
		const last = messages[ messages.length - 1 ];
		return ( !!last && last.role === role && last.content === content );
	};

	// Skip synthetic handoff-resume injected message
	const isHandoffResume = ( msg: MessageLike ): boolean =>
	{
		return ( msg.info.role === "user" && msg.info.id === "handoff-resume" );
	};

	// Skip messages already processed in previous transform calls
	const isAlreadySeen = ( msg: MessageLike ): boolean =>
	{
		return ( !!msg.info.id && seenMessageIds.has( msg.info.id ) ) ;
	};

	// Check if periodic write should fire
	const shouldWritePeriodic = (): boolean =>
	{
		return ( opts.every_messages > 0 && messages.length >= opts.every_messages );
	};

	// Write current messages to .handoff/<ts>.md, skip if buffer empty
	const writeHandoff = ( reason: string, entries: MessageEntry[] = messages ): void =>
	{
		if ( entries.length <= 0 )
		{
			log( LOG_LEVEL.DEBUG, `Handoff skipped (no messages): ${reason}` );
			return ;
		}
		try
		{
			const ts = timestamp() ;
			const path = join( handoffDir, `${ts}.md` );
			const content = buildFileContent( ts, reason, entries, opts.keep_last );

			mkdirSync( handoffDir, { recursive: true } );
			writeFileSync( path, content );

			rotateHandoffFiles( handoffDir, opts.max_stored_files );

			log( LOG_LEVEL.INFO, `Handoff written: ${reason}: ${path}` );
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `write failed: ${( err as Error ).message}` );
		}
	};

	// Handler for process.once("exit"): write handoff if on_exit enabled
	const onExit = (): void =>
	{
		if ( !opts.on_exit ) return ;

		try
		{
			writeHandoff( `exit (${messages.length} messages)` );
			flushMessages() ;
		}
		catch { /* non-fatal */ }
	};

	process.once( "exit", onExit );

	// Load recent handoff files into buffer for injection on first turn
	const loadHandoffs = (): MessageEntry[] | null =>
	{
		if ( !opts.on_start ) return null ;

		try
		{
			const files = listHandoffFiles( handoffDir );
			const loadCount = Math.min( opts.max_load_files, files.length );

			if ( loadCount === 0 ) return null ;

			const entries = files.slice( -loadCount )
				.flatMap( f => parseFeedback( readFileSync( join( handoffDir, f ), "utf8" ) ) )
				.slice( -opts.keep_last );

			log( LOG_LEVEL.INFO, `Handoff loaded: ${loadCount} file(s), ${entries.length} messages` );
			return entries ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `on_start load failed: ${( err as Error ).message}` );
			return null ;
		}
	};

	let pendingHandoff: MessageEntry[] | null = loadHandoffs();

	// Fetch messages from session via SDK — safety net for dispose only.
	// Brings the full window (keep_last) including the last assistant message
	// that the buffer may not have captured yet.
	const fetchMessages = async ( sessionID: string, limit: number ): Promise<MessageEntry[]> =>
	{
		try
		{
			const result = await ctx.client.session.messages( {
				path  : { id : sessionID } ,
				query : limit > 0 ? { limit } : undefined ,
			} ) ;

			const all = result?.data ;
			if ( !Array.isArray( all ) ) return [] ;

			const entries: MessageEntry[] = [] ;

			for ( const msg of all )
			{
				const info = msg.info ;
				if ( !info || !info.role ) continue ;
				if ( info.role !== "user" && info.role !== "assistant" ) continue ;
				if ( info.id === "handoff-resume" ) continue ;

				const text = extractText( msg as MessageLike ) ;
				if ( !text ) continue ;

				entries.push( { role : info.role, content : text } ) ;
			}

			log( LOG_LEVEL.DEBUG, `fetchMessages: ${entries.length} entries from ${all.length} messages` ) ;
			return entries ;
		}
		catch
		{
			log( LOG_LEVEL.ERROR, `fetchMessages failed` ) ;
			return [] ;
		}
	} ;

	// Inject pending handoff into output messages (once on first turn)
	const injectHandoff = ( output: { messages?: MessageLike[] } ): boolean =>
	{
		if ( pendingHandoff === null || !output.messages?.length ) return true ;
		if ( !output.messages.some( m => m.info?.role === "user" || m.info?.role === "assistant" ) ) return false ;

		const injection = buildInjection( pendingHandoff );

		output.messages.unshift( {
			info: { role: "user", id: "handoff-resume" },
			parts: [ { type: "text", text: injection } ],
		} as MessageLike );

		log( LOG_LEVEL.INFO, `Handoff injected: ${pendingHandoff.length} messages, ${injection.length} bytes` );

		if ( CONFIG.log_level === "debug" )
		{
			writeFileSync( join( projectDir, "handoff-resume.txt" ), injection );
			log( LOG_LEVEL.DEBUG, `handoff-resume.txt written` );
		}

		pendingHandoff = null ;
		flushMessages() ;

		return true ;
	};

	log( LOG_LEVEL.INFO, `Initialized | project: ${projectDir}` );

	return {
		"experimental.chat.messages.transform": async ( _input, output ) =>
		{
			try
			{
				if ( !injectHandoff( output ) ) return ;
				if ( !output.messages?.length ) return ;

				for ( const msg of output.messages )
				{
					if ( isHandoffResume( msg ) ) continue ;
					if ( isAlreadySeen( msg ) ) continue ;

					if ( msg.info?.sessionID ) currentSessionID = msg.info.sessionID ;

					const text = extractText( msg as MessageLike );
					if ( !text ) continue ;

					if ( isDedup( msg.info.role, text ) ) continue ;

					messages.push( { role: msg.info.role, content: text } );

					if ( msg.info.id ) seenMessageIds.add( msg.info.id ) ;
				}

				if ( shouldWritePeriodic() )
				{
					writeHandoff( `periodic (${messages.length} messages)` );
					flushMessages() ;
				}
			}
			catch ( err )
			{
				log( LOG_LEVEL.ERROR, `messages.transform: ${( err as Error ).message}` );
			}
		},

		dispose: async () =>
		{
			if ( opts.on_exit )
			{
				try
				{
					let entries: MessageEntry[] = [] ;

					if ( currentSessionID )
					{
						entries = await fetchMessages( currentSessionID, opts.keep_last ) ;
						if ( entries.length === 0 && messages.length > 0 ) entries = messages ;
					}
					else if ( messages.length > 0 )
					{
						entries = messages ;
					}

					if ( entries.length > 0 )
					{
						writeHandoff( `dispose (${entries.length} messages)`, entries ) ;
					}

					flushMessages() ;
				}
				catch { /* non-fatal */ }
			}

			process.removeListener( "exit", onExit ) ;
			log( LOG_LEVEL.INFO, "Disposed" );
		},
	};
} ) satisfies Plugin ;
