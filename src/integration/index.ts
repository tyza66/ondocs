/**
 * ondocs/integration: what the Docusaurus, Astro and Starlight integrations are built from, for
 * an integration with another framework. After the framework builds the site, read the pages it
 * wrote (`readBuiltHtml`, `loadBuiltPage`), build the embedding model (`buildEmbedding`), write
 * the index (`writeSiteIndex`) and the llms files (`writeLlmsFiles`); while it configures the
 * site, add the launcher to every page (`launcherScript`, `LAUNCHER_STYLESHEETS`) pointed at
 * `dialogEndpoint`, and check the options it was given (`checkOptions`). Node.js only.
 *
 * See "Writing an integration" in the docs.
 */

export {
  buildEmbedding,
  checkIndexOptions,
  consoleLogger,
  dialogEndpoint,
  excluder,
  hintDevEndpoint,
  indexCache,
  resolveMcp,
  warnMissingDialogPeers,
  writeSiteIndex,
} from './build';
export type { IndexOptions, Logger, McpOption, WriteSiteIndexOptions } from './build';
export { llmsOutputs, writeLlmsFiles } from './llms';
export type { LlmsOutput, LlmsTxtOption, WriteLlmsFilesOptions } from './llms';
export { loadBuiltPage, readBuiltHtml } from './pages';
export type { BuiltPage, BuiltPageOptions } from './pages';
export { LAUNCHER_STYLESHEETS, launcherScript, quietUseClient } from './launcher';
export { checkOptions, optionRules } from './options';
export type { OptionRule, OptionRuleSet, OptionRules, OptionShapeExtras } from './options';
export type { LauncherDialogOptions, LauncherScriptOptions, LocaleDialogOptions } from './launcher';

// The types those take and return, so an integration needs no other import.
export type { EmbeddingProviderOptions } from '../build';
export type { OndocsDialogOptions, OndocsTheme } from '../embed/options';
export type { LlmsOutputs, LlmsPage, LlmsSite } from '../llms';
export type { EmbeddingSpec } from '../node/embedding';
export type { ChunkingOptions, SourceDocument } from '../types';
