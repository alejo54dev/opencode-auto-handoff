/**
*	auto-handoff.ts
*
*	OpenCode plugin — periodic + exit handoff writer, startup handoff reader.
*	Writes .handoff/<timestamp>.md every N messages (user + assistant) and on session exit.
*	Loads handoffs on startup. No keywords, no database.
*
*	Install: cp auto-handoff.ts ~/.config/opencode/plugins/auto-handoff.ts
*	Config:  ~/.config/opencode/auto-handoff.json
*	Log:     ~/.config/opencode/auto-handoff.log
*	Output: <project>/.handoff/<timestamp>.md
*
*	@example ~/.config/opencode/auto-handoff.json
*	{
*		"every_messages": 20,   // periodic write every N messages (0 = never)
*		"on_exit": true,        // write on dispose hook + process.once("exit")
*		"on_start": true,       // load handoffs on startup
*		"keep_last": 20,        // recent messages per handoff
*		"max_stored_files": 10, // rotation limit
*		"max_load_files": 3,    // how many recent handoffs to load
*		"log_level": "info"     // silent, error, info, debug
*	}
*
*	@name auto-handoff plugin.
*	@version 1.0.25
*	@author Alejandro Carraretto
*	@author MiniMax-M3
*	@license MIT
*/

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "auto-handoff.json" ) ;
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
	every_messages: 20,
	on_exit: true,
	on_start: true,
	keep_last: 20,
	max_stored_files: 10,
	max_load_files: 3,
	log_level: "info" as "silent" | "error" | "info" | "debug",
};

// ─── Interfaces ────────────────────────────────────────────────────────────

interface MessageLike
{
	info: { role: "user" | "assistant"; id?: string };
	parts: Array<{ type: string; text?: string }>;
}

// ─── Config ────────────────────────────────────────────────────────────────

function loadConfig(): typeof CONFIG
{
	let file : Record<string, unknown> = {};

	try
	{
		file = JSON.parse( readFileSync( CONFIG_FILE, "utf8" ) );
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
		return ;
	}

	const opts =
	{
		every_messages:    Math.max( 0, file.every_messages   ?? CONFIG.every_messages   ),
		on_exit:           file.on_exit                       ?? CONFIG.on_exit           ,
		on_start:          file.on_start                      ?? CONFIG.on_start          ,
		keep_last:         Math.max( 1, file.keep_last        ?? CONFIG.keep_last        ),
		max_stored_files:  Math.max( 1, file.max_stored_files ?? CONFIG.max_stored_files ),
		max_load_files:    Math.max( 1, file.max_load_files   ?? CONFIG.max_load_files   ),
		log_level:         file.log_level                     ?? CONFIG.log_level         ,
	} as typeof CONFIG;

	CONFIG.log_level = opts.log_level;

	log( LOG_LEVEL.INFO, "Config loaded" ) ;

	return opts;
}

// ─── Logger ────────────────────────────────────────────────────────────────

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

function timestamp(): string
{
	return new Date().toISOString().slice( 0, 16 ).replace( 'T', '-' ).replace( ':', '' ) ;
}

const extractText = ( msg: MessageLike ): string =>
	( msg.parts ?? [] )
		.filter( p => p.type === "text" && typeof p.text === "string" )
		.map( p => p.text! )
		.join( "\n" )
		.replace( /<system-reminder>[\s\S]*?<\/system-reminder>/g, "" )
		.trim();

const extractFeedback = ( content: string ): string =>
	content
		.split( "\n" )
		.filter( line => /^\s*-\s*\[(user|assistant)\]/.test( line ) )
		.join( "\n" );

const listHandoffFiles = ( dir: string ): string[] =>
	existsSync( dir )
		? readdirSync( dir ).filter( f => f.endsWith( ".md" ) ).sort()
		: [];

const rotateHandoffFiles = ( dir: string, maxStored: number ): void =>
{
	const files = listHandoffFiles( dir );
	const excess = files.length - maxStored;
	if ( excess <= 0 ) return;

	files.slice( 0, excess ).forEach( f =>
	{
		try { unlinkSync( join( dir, f ) ); } catch { /* non-fatal */ }
	} );
};

// ─── Templates ─────────────────────────────────────────────────────────────

const readTemplate = ( handoff: string ): string =>
	`## Resume previous session — handoff loaded\n\n` +
	`Read it and present a clear, structured markdown summary that covers:\n\n` +
	`- **Where we left off** — last task and current state\n` +
	`- **Key context** — files touched, decisions made, constraints discovered\n` +
	`- **Next step** — what was pending or in progress\n` +
	`- **Load skills** — load the prefixed skills\n\n` +
	`Then wait for the user's next instruction.\n\n` +
	`---\n\n` +
	`${handoff}` +
	`\n\n---`;

const writeTemplate = ( ts: string, reason: string, messagesBlock: string ): string =>
	`# Handoff — ${ts}\n\n` +
	`## Reason\n${reason}\n\n` +
	`${messagesBlock}\n`;

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( ctx: PluginInput, rawOptions?: PluginOptions ) =>
{
	const opts = loadConfig();
	const projectDir = ctx.directory;

	const messages: Array<{ role: string; content: string }> = [];
	let lastSeenMessageId: string | null = null;

	let pendingHandoff: string | null = null;

	const flushMessages = (): void =>
	{
		messages.length = 0;
	};

	const writeHandoff = ( reason: string ): void =>
	{
		if ( messages.length === 0 )
		{
			log( LOG_LEVEL.DEBUG, `Handoff skipped (no messages): ${reason}` );
			return;
		}

		try
		{
			const ts = timestamp();
			const dir = join( projectDir, ".handoff" );
			const path = join( dir, `${ts}.md` );

			const recent = messages.slice( -opts.keep_last );

			const messagesBlock = recent.length > 0
				? recent.map( m => `- [${m.role}] ${m.content}` ).join( "\n" )
				: "(no messages captured)";

			const content = writeTemplate( ts, reason, messagesBlock );

			mkdirSync( dir, { recursive: true } );
			writeFileSync( path, content );

			rotateHandoffFiles( dir, opts.max_stored_files );

			log( LOG_LEVEL.INFO, `Handoff written: ${reason}: ${path}` );
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `write failed: ${( err as Error ).message}` );
		}
	};

	const onExit = (): void =>
	{
		if ( !opts.on_exit ) return;

		try
		{
			writeHandoff( `exit (${messages.length} messages)` );
			flushMessages();
		}
		catch { /* non-fatal */ }
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
				const selected = files.slice( -loadCount ).reverse();
				const stack = selected
					.map( f => extractFeedback( readFileSync( join( dir, f ), "utf8" ) ) )
					.filter( block => block.length > 0 )
					.join( "\n\n---\n\n" );

				pendingHandoff = stack;
				log( LOG_LEVEL.INFO, `Handoff loaded: ${loadCount} file(s)` );
			}
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `on_start load failed: ${( err as Error ).message}` );
		}
	}

	log( LOG_LEVEL.INFO, `Initialized | project: ${projectDir} | cfg: ${JSON.stringify( opts )}` );

	return {
		"experimental.chat.messages.transform": async ( _input, output ) =>
		{
			try
			{
				if ( pendingHandoff !== null && output.messages )
				{
					output.messages.unshift( {
						info: { role: "user", id: "handoff-resume" },
						parts: [ { type: "text", text: readTemplate( pendingHandoff ) } ],
					} as MessageLike );

					pendingHandoff = null;
					flushMessages();

					log( LOG_LEVEL.INFO, "Handoff injected into context" );
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

				if ( opts.every_messages > 0 && messages.length >= opts.every_messages )
				{
					writeHandoff( `periodic (${messages.length} messages)` );
					flushMessages();
				}
			}
			catch ( err )
			{
				log( LOG_LEVEL.ERROR, `messages.transform: ${( err as Error ).message}` );
			}
		},

		dispose: async () =>
		{
			process.removeListener( "exit", onExit );

			if ( opts.on_exit )
			{
				try
				{
					writeHandoff( `dispose (${messages.length} messages)` );
					flushMessages();
				}
				catch { /* non-fatal */ }
			}
			log( LOG_LEVEL.INFO, "Disposed" );
		},
	};
} ) satisfies Plugin;
