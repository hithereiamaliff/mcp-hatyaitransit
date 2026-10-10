/**
 * Loads a local .env file (if there is one) into process.env.
 *
 * Import this FIRST in every entry point (http-server.ts, stdio.ts) so the settings are in
 * place before anything reads them.
 *
 * `quiet: true` matters: dotenv 17 prints a banner to stdout by default, and in stdio mode
 * stdout is the MCP protocol channel, so any stray text there would break the connection.
 */
import { config } from 'dotenv';

config({ quiet: true });
