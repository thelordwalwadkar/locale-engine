/** Mutable working state of one segment for one target locale, and the contexts the stage modules share. */
import type { LoadedConfig } from '../config/load.js';
import type { GlossaryHit } from '../config/glossary.js';
import type { LintContext, LintResult, MarketClaim } from '../lint/types.js';
import type {
  Change,
  Finding,
  FormatChange,
  JudgeWireItem,
  LocaleCode,
  MarketFacts,
  Operation,
  PageType,
  RepairRecord,
  ResolvedLocaleProfile,
  Segment,
  SourceDocument,
} from '../schemas/index.js';
import type { CostTracker } from '../telemetry/cost.js';
import type { RunLog } from '../telemetry/run-log.js';
import type { MarketClaimPayload } from './payloads.js';
import type { PromptKit } from './prompt.js';
import type { ScoringSettings } from './scoring.js';
import type { StageRunner } from './stage-runner.js';

export interface StageSwitches {
  translate: boolean;
  localize: boolean;
  validate: boolean;
  repair: boolean;
  backtranslate: boolean;
}

export interface RunSettings {
  passThreshold: number;
  maxRepairLoops: number;
  stages: StageSwitches;
}

export interface RunContext {
  config: LoadedConfig;
  settings: RunSettings;
  kit: PromptKit;
  runner: StageRunner;
  log: RunLog;
  costs: CostTracker;
  scoring: ScoringSettings;
}

export interface LocaleContext {
  run: RunContext;
  target: LocaleCode;
  profile: ResolvedLocaleProfile;
  lint: LintContext;
  facts: MarketFacts | undefined;
  doc: SourceDocument;
  pageType: PageType;
  /** Set when the cost ceiling stopped further model calls for this run. */
  halted: boolean;
  /** Sequence for finding ids (F-<locale>-0001 …), assigned in segment order when results are built. */
  findingSeq: number;
  /** Findings not tied to a segment (document-level rules); recomputed after every validation pass. */
  docFindings: Finding[];
}

export type SegStatus = 'OK' | 'PROVIDER_ERROR' | 'NOT_PROCESSED';

export interface SegValidationState {
  lint: LintResult;
  judge: JudgeWireItem | null;
  /** Current findings of the latest validation pass (open). */
  findings: Finding[];
  /** Document-level rule findings that concern this segment (first mention, …); recomputed after every pass. */
  docFindings: Finding[];
  /** Findings of earlier passes that a repair resolved (status 'fixed'). */
  history: Finding[];
  /** Judge confidence of the latest pass. */
  confidence: number | null;
  recommendations: string[];
}

export interface SegState {
  seg: Segment;
  lang: string;
  langConfidence: number;
  /** Locale of the segment's language on the source page (nl-NL, en-*). */
  segmentLocale: string;
  operation: Operation;
  status: SegStatus;
  translation: string | null;
  localized: string | null;
  /** The current candidate of the published text. */
  text: string | null;
  changes: Change[];
  formatChanges: FormatChange[];
  entitiesPreserved: string[];
  terminology: Array<{ source: string; target: string; rule: string }>;
  /** The localization stage asked for human review. */
  llmReview: boolean;
  reviewReasons: string[];
  repairs: RepairRecord[];
  notes: string[];
  glossaryHits: GlossaryHit[];
  claims: MarketClaim[];
  claimActions: MarketClaimPayload[];
  backTranslation: { text: string; lang: string } | null;
  validation: SegValidationState | null;
  /** Number of repair passes already applied to this segment. */
  repairLoops: number;
  /** Set when text changed since the last validation. */
  dirty: boolean;
}
