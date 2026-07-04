/**
 *	test-clean-patterns.ts
 *
 *	Tests STRIP_PATTERNS regexes (mirrors auto-handoff.ts).
 *	Imports the plugin to verify module loads cleanly.
 */

import autoHandoffPlugin from "./auto-handoff.ts";

// Verify plugin loads (can't invoke without opencode runtime)
console.log( `Plugin type: ${typeof autoHandoffPlugin}` );

// Mirror of auto-handoff.ts STRIP_PATTERNS
const STRIP_PATTERNS =
[
	/[\s\S]*?<\/dcp-message-id>/g,
	/<system-reminder>[\s\S]*?<\/system-reminder>/g,
	/<system>[\s\S]*?<\/system>/g,
	/<thinking>[\s\S]*?<\/thinking>/g,
	/<tool_result>[\s\S]*?<\/tool_result>/g,
	/▣\s*(?:DCP|Compression)[\s\S]*/g,
];

const strip = ( text: string ): string =>
{
	let t = text;
	for ( const p of STRIP_PATTERNS )
		t = t.replace( p, "" );
	return t.trim();
};

const tests =
[
	{
		name: "compress DCP notification",
		input:  "▣ DCP | -17K removed, +1K summary\n\n│⣿⣿⣿⣿│\n▣ Compression #1 -17K removed, +1K summary\n→ Items: 20 messages and 17 tools compressed",
		expect: "",
	},
	{
		name: "system-reminder tag",
		input:  "hello <system-reminder>noise</system-reminder> world",
		expect: "hello  world",
	},
	{
		name: "dcp-message-id tag",
		input:  "<dcp-message-id>m0123</dcp-message-id>real content",
		expect: "real content",
	},
	{
		name: "system tag",
		input:  "before<system>inner</system>after",
		expect: "beforeafter",
	},
	{
		name: "thinking tag",
		input:  "text <thinking>internal</thinking> end",
		expect: "text  end",
	},
	{
		name: "tool_result tag",
		input:  "<tool_result>some output</tool_result>remaining",
		expect: "remaining",
	},
	{
		name: "normal message unchanged",
		input:  "- [user] hola que tal",
		expect: "- [user] hola que tal",
	},
];

// ── Generate report ──────────────────────────────────────────────────────

import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let report = "# Clean patterns test\n\n";
report += `Plugin loads: ${typeof autoHandoffPlugin}\n\n`;

report += `## Patterns (${STRIP_PATTERNS.length})\n\n`;
STRIP_PATTERNS.forEach( ( p, i ) => report += `${i + 1}. \`/${p.source}/\`\n` );

report += `\n## Test cases\n\n`;
let ok = 0;
for ( const t of tests )
{
	const result = strip( t.input );
	const pass = result === t.expect;
	if ( pass ) ok++;
	const icon = pass ? "✅" : "❌";

	report += `### ${icon} ${t.name}\n`;
	report += `Input:  \`${t.input}\`\n`;
	report += `Output: \`${result}\`\n`;
	report += `Length: ${t.input.length} → ${result.length}\n\n`;

	if ( !pass )
	{
		report += `EXPECTED: \`${t.expect}\`\n\n`;
		console.log( "❌", t.name, "| got:", JSON.stringify( result ), "| exp:", JSON.stringify( t.expect ) );
	}
	else console.log( "✅", t.name );
}

report += `**${ok}/${tests.length} passed**\n\n`;

// ── Real handoff files ──────────────────────────────────────────────────

const dir = join( import.meta.dir, ".handoff" );
const files = existsSync( dir )
	? readdirSync( dir ).filter( f => f.endsWith( ".md" ) ).sort()
	: [];

if ( files.length > 0 )
{
	const loadCount = Math.min( 3, files.length );
	const selected = files.slice( -loadCount );

	report += `## Handoff files (${loadCount} newest of ${files.length})\n\n`;
	selected.forEach( f =>
	{
		const raw = readFileSync( join( dir, f ), "utf8" );
		const cleaned = strip( raw );
		const wasDirty = raw !== cleaned;

		report += `### ${f}\n`;
		if ( wasDirty )
		{
			const dirtyLen = raw.length;
			const cleanLen = cleaned.length;
			report += `Stripped: ${dirtyLen - cleanLen} chars removed\n`;
			report += `Before:\n\`\`\`\n${raw.slice( 0, 500 )}...\n\`\`\`\n`;
			report += `After:\n\`\`\`\n${cleaned.slice( 0, 500 )}...\n\`\`\`\n`;
		}
		else
		{
			report += `No noise found (already clean)\n`;
		}
		report += `\n`;
	} );
}
else
{
	report += `## Handoff files\n\nNo handoff files found.\n`;
}

// ── Write ───────────────────────────────────────────────────────────────

const outPath = join( import.meta.dir, "test-clean-result.txt" );
writeFileSync( outPath, report, "utf8" );
console.log( `\nReport written: ${outPath} (${report.length} bytes)` );

if ( ok !== tests.length ) process.exit( 1 );
