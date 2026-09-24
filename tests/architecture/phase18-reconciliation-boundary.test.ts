import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, computeReachable, findPath } from './support/import-graph';

// [P18-ARCH] Static architecture proof for Phase18 reconciliation, over the
// same TRUE TRANSITIVE TypeScript import graph the Phase14/17 proofs use — not
// a grep, and not a filename convention.
//
// What this file proves:
//   1. reconciliation domain code depends on narrow PORTS, never on raw HTTP,
//      a signer, a credential, or any CoinDCX module (§20);
//   2. Phase18 introduces NO second mutation owner: orphan cancellation travels
//      the already-approved Phase17 gateway (§9.1, §20);
//   3. paper execution remains structurally unable to reach reconciliation (§19);
//   4. nothing under reconciliation contains pair-specific executable logic (§22);
//   5. no test can send a real CoinDCX mutation (§25).

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');

const { files, graph, unresolved } = buildImportGraph(SRC_ROOT, REPO_ROOT);

const RECONCILIATION_ROOT = 'src/execution/live/reconciliation/';
const MUTATION_TRANSPORT = 'src/integration/coindcx/live/mutation-transport.ts';
const MUTATION_ADAPTER = 'src/integration/coindcx/live/order-gateway.ts';
const APPROVED_ROOT = 'src/integration/coindcx/live/production-runtime.ts';
const EVIDENCE_ADAPTER = 'src/integration/coindcx/live/reconciliation-evidence-adapter.ts';

const reconciliationFiles = files.filter((file) => file.startsWith(RECONCILIATION_ROOT));

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** Source with comments stripped, so prose describing a rule never satisfies it. */
function codeOf(file: string): string {
  return sourceOf(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// [F18-33, hardened C1.3 (F18-34/35/36), C1.4 (F18-37), C1.5 (F18-38/39) and
// C1.6 (F18-40/41/42)] Second-layer guard against a false claim that
// `resolvedBy` is an authenticated/verified/trusted/authorized identity,
// beside the exact-phrase ban in `P18-§F18-31`.
//
// Every qualifier is scoped to the smallest local claim it belongs to:
//   1. parentheticals are evaluated on their own, and the enclosing text is
//      evaluated with them removed, so neither can qualify the other;
//   2. text splits at strong boundaries (`. ! ? ; :`, em/en dash, spaced
//      hyphen) and at contrastive transitions (but/however/while/whereas/
//      yet/although/though/nevertheless/nonetheless/on the other hand);
//   3. a segment with several `resolvedBy` mentions splits at each mention,
//      so one mention's qualifier never covers another (mentions joined only
//      by punctuation or and/or/nor are one coordinated subject);
//   4. a negation excuses a claim only if it PRECEDES the claim's first
//      concept word -- a trailing "not" belongs to something else;
//   5. [F18-40] material before the mention stays in its claim only when it
//      grammatically governs the mention: there is no clause break at all,
//      the mention is the OBJECT of a future-action verb ("... and derive
//      resolvedBy from ..."), or the whole prefix is one once/exists or
//      when/added subordinate clause. When the mention instead starts a new
//      clause after a comma or and/or/nor/then, the claim starts at that new
//      clause; the connector word alone decides nothing;
//   6. [F18-41] future evidence counts only when it governs the resolvedBy
//      predicate: a modal directly on it ("resolvedBy will/should/may be
//      ..."), a governing once/when subordinate clause, or a future marker in
//      the governing clause whose object is resolvedBy. A modal or "future"
//      appearing after the identity assertion is complete does not count, and
//      an explicit present-tense anchor ("resolvedBy currently ...") always
//      overrides;
//   7. [F18-42] a clause with no mention that follows one that had a subject
//      inherits resolvedBy UNLESS it opens with its own explicit subject (a
//      determiner, a pronoun other than "it", an auxiliary-inverted question,
//      or a bare noun that is not a finite-verb form). There is no closed
//      predicate-verb allowlist; a finite verb is recognized by shape.
//   8. [F18-43] a quantified mention used as a word ("any `resolvedBy`
//      mention") is metalinguistic only by what its PREDICATE does, never by
//      the noun phrase alone. It is excused when it is the object of a
//      text-analysis verb ("flags any ... mention that ...", "does this
//      clause contain a ... mention?") and not itself the subject of an
//      embedded finite predicate, or when its own predicate is a
//      text-analysis passive naming what the analysis looks for ("is checked
//      for ... wording"), with any coordinated predicate after that still
//      judged. Any other predicate ("a ... mention stores/identifies/is/has
//      been ...") is an ordinary claim about resolvedBy.
const RESOLVEDBY_MENTION = /resolved_?by/g;
// [F18-34] Prefix matches cover every inflection (authenticated/authentication,
// verified/verification, authorized/authorised/authorization, approved/
// approving/approver).
const RESOLVEDBY_CONCEPT = /authenticat|verifi|trusted|authoriz|authoris|approv|\bprincipal\b|\buser\b|administrator|\badmin\b|operator identity|human identity/;
const RESOLVEDBY_NEGATION = /\bnot\b|n't\b|\bnever\b|\bno\b|\bneither\b/;
// [F18-35] The required future phrasings without the literal word "future"
// ("once ... exists", "when ... is added") have their own patterns.
const RESOLVEDBY_GOVERNING_FUTURE = /\bfuture\b|\bonce\b[\s\S]*?\bexists\b|\bwhen\b[\s\S]*?\badded\b|\b(?:will|shall|would|should|might|may|must)\b/;
const RESOLVEDBY_FUTURE_SUBORDINATE_PREFIX = /^\s*(?:once\b[^,]*\bexists|when\b[^,]*\badded)\b[^,]*,\s*$/;
const RESOLVEDBY_PREDICATE_MODAL = /^[^a-z]*(?:(?:[a-z]+ly|still|also|then|later|eventually)\s+)*(?:will|shall|would|should|might|may)\b/;
const RESOLVEDBY_PRESENT_ANCHOR = /resolved_?by`?\s+(?:is\s+|are\s+)?(?:currently|today|now|presently|at present)\b|\b(?:currently|today|presently|at present),?\s+`?resolved_?by/;
const RESOLVEDBY_METALINGUISTIC_MENTION = /\b(?:any|every|each|a|the)\s+[^a-z]*resolved_?by[^a-z]*(?:resolved_?by[^a-z]*)?\s*mentions?\b/;
// [F18-43] Verbs (and "for") that take a mention as the TEXT being analysed.
// Dual-meaning verbs (record/store/hold/name/contain-as-value) are
// deliberately absent, except "contain" in its auxiliary-inverted question
// form, which is checked separately.
const META_ANALYSIS_GOVERNORS = new Set(['flag', 'flags', 'flagged', 'find', 'finds', 'detect', 'detects', 'detected', 'match', 'matches', 'matched', 'check', 'checks', 'checked', 'inspect', 'inspects', 'inspected', 'scan', 'scans', 'scanned', 'reject', 'rejects', 'rejected', 'catch', 'catches', 'parse', 'parses', 'analyze', 'analyzes', 'analyse', 'analyses', 'for']);
const META_CONTAINS_QUESTION = /\b(?:does|do|did)\s+(?:this|that|the|a|each|every|any)\s+(?:[a-z-]+\s+){0,3}contain\s*$/;
// What may follow the analysed mention without being a predicate of its own:
// a relative clause, a participle, or a locative phrase.
const META_POST_MODIFIER_OPENERS = new Set(['that', 'which', 'whose', 'found', 'seen', 'used', 'written', 'appearing', 'occurring', 'in', 'within', 'inside', 'near', 'across', 'throughout', 'anywhere']);
const META_LOCATIVE_POST_MODIFIER = /^(?:(?:found|seen|used|written|appearing|occurring)\s+)?(?:in|within|inside|near|across|throughout)\s+(?:(?:this|that|the|a|an|any|each|every|its|our)\s+)?[a-z0-9-]+\s+/;
const META_TEXT_ANALYSIS_PREDICATE = /^(?:is|are|gets|get)\s+(?:(?:[a-z]+ly|also|still|always|then)\s+)?(?:inspected|checked|analy[sz]ed|scanned|parsed|matched|flagged|detected|examined|evaluated|tested|reviewed)\s+for\s+(?:(?!(?:and|or|nor|but|then)\b)[a-z-]+\s+){0,4}?(?:wording|words?|claims?|language|phrases?|terms?|text|concepts?|assertions?|keywords?)\b/;
const STRONG_BOUNDARY = /[.!?;:—–]+|\s-{1,2}\s/;
const CONTRAST_TRANSITION = /\b(?:but|however|while|whereas|yet|although|though|nevertheless|nonetheless|on the other hand)\b/;
const COORDINATED_MENTION_GAP = new Set(['', 'and', 'or', 'nor']);
const LEADING_CLAUSE_BREAK = /,|\b(?:and|or|nor|then)\b/g;
// [F18-40] Base-form actions that take resolvedBy as their object in a future
// design ("... and derive resolvedBy from ..."). A verb missing from this set
// fails loud: the prefix is dropped and the claim is judged on its own.
const GOVERNING_ACTION_VERBS = new Set(['derive', 'populate', 'set', 'fill', 'assign', 'source', 'obtain', 'take', 'bind', 'stamp', 'write', 'record', 'store', 'compute', 'attach', 'copy', 'map', 'pull', 'read', 'use', 'build', 'construct', 'generate', 'supply', 'provide', 'produce', 'emit', 'pass', 'forward', 'propagate', 'persist', 'save', 'create', 'issue', 'fetch', 'resolve', 'determine', 'fix']);
const TRAILING_OBJECT_DETERMINER = /(?:\s+(?:the|its|a|an|that|this))+\s*$/;
const CONTINUATION_SUBORDINATE = /^(?:once|when)\b[^,]*,\s*/;
const CONTINUATION_FILLER = /^(?:in practice|in fact|in effect|at present|right now|currently|now|today|presently|still|also|then|actually|really|just|merely|[a-z]+ly)\b\s*/;
const SUBJECT_DETERMINERS = new Set(['the', 'a', 'an', 'these', 'those', 'its', 'their', 'our', 'your', 'his', 'her', 'my', 'any', 'each', 'every', 'some', 'another', 'such', 'no', 'all', 'both', 'either', 'neither']);
const SUBJECT_PRONOUNS = new Set(['he', 'she', 'they', 'we', 'you', 'i', 'one', 'someone', 'nobody', 'everyone', 'anyone', 'there']);
const DEMONSTRATIVES = new Set(['this', 'that']);
const INVERSION_AUXILIARY = new Set(['does', 'do', 'did']);
const FINITE_AUXILIARY = new Set(['is', 'are', 'was', 'were', 'has', 'have', 'had', 'does', 'do', 'did', 'will', 'shall', 'would', 'should', 'might', 'may', 'must', 'can', 'could', 'remains', 'becomes']);
const OBJECT_OPENERS = new Set(['the', 'a', 'an', 'its', 'their', 'that', 'this', 'these', 'those', 'which', 'whether', 'who', 'what', 'whoever', 'as', 'to', 'from', 'with', 'only', 'exactly', 'no', 'any', 'every', 'each', 'some', 'one', 'our', 'your', 'his', 'her', '']);
const PARTICIPLE_CONCEPT = /^(?:authenticated|verified|trusted|authori[sz]ed|approved)$/;

function extractParentheticals(text: string): readonly string[] {
  const units: string[] = [];
  let outer = text;
  const innermost = /\(([^()]*)\)/;
  for (let match = innermost.exec(outer); match !== null; match = innermost.exec(outer)) {
    units.push(match[1] ?? '');
    outer = `${outer.slice(0, match.index)} ${outer.slice(match.index + match[0].length)}`;
  }
  units.push(outer);
  return units;
}

/** One inner array per parenthetical/outer unit, so an [F18-39] elided-subject continuation never inherits across a unit boundary. */
function splitIntoSegmentsByUnit(text: string): readonly (readonly string[])[] {
  const unitGroups: string[][] = [];
  for (const unit of extractParentheticals(text.toLowerCase().replace(/\s+/g, ' '))) {
    const segments: string[] = [];
    for (const part of unit.split(STRONG_BOUNDARY)) {
      for (const clause of part.split(CONTRAST_TRANSITION)) {
        const trimmed = clause.trim();
        if (trimmed.length > 0) segments.push(trimmed);
      }
    }
    if (segments.length > 0) unitGroups.push(segments);
  }
  return unitGroups;
}

function wordsOf(text: string): string[] {
  return text.split(/[^a-z]+/).filter((word) => word.length > 0);
}

/** [F18-40] resolvedBy is the object of a governing future-action verb ("... derive resolvedBy"). */
function isGovernedObject(prefix: string): boolean {
  const beforeObject = prefix.replace(/[^a-z]+$/, '').replace(TRAILING_OBJECT_DETERMINER, '');
  return GOVERNING_ACTION_VERBS.has(wordsOf(beforeObject).pop() ?? '');
}

/** [F18-40] Where the first resolvedBy mention's local claim begins. */
function localClaimStart(segment: string, mentionStart: number): number {
  const prefix = segment.slice(0, mentionStart);
  if (RESOLVEDBY_FUTURE_SUBORDINATE_PREFIX.test(prefix)) return 0;
  let breakEnd = -1;
  for (const hit of prefix.matchAll(LEADING_CLAUSE_BREAK)) breakEnd = hit.index + hit[0].length;
  if (breakEnd === -1 || isGovernedObject(prefix)) return 0;
  return breakEnd;
}

function splitIntoMentionClaims(segment: string): readonly string[] {
  const groups: { start: number; end: number }[] = [];
  for (const hit of segment.matchAll(RESOLVEDBY_MENTION)) {
    const previous = groups[groups.length - 1];
    const gap = previous ? segment.slice(previous.end, hit.index).replace(/[^a-z]+/g, ' ').trim() : null;
    if (previous && gap !== null && COORDINATED_MENTION_GAP.has(gap)) {
      previous.end = hit.index + hit[0].length;
    } else {
      groups.push({ start: hit.index, end: hit.index + hit[0].length });
    }
  }
  return groups.map((group, i) => {
    const start = i === 0 ? localClaimStart(segment, group.start) : group.start;
    const end = i + 1 < groups.length ? (groups[i + 1]?.start ?? segment.length) : segment.length;
    return segment.slice(start, end).trim();
  });
}

/** [F18-41] Future evidence that actually governs the resolvedBy predicate. */
function hasGoverningFutureEvidence(claim: string): boolean {
  const mention = /resolved_?by/.exec(claim);
  if (mention === null) return false;
  const prefix = claim.slice(0, mention.index);
  if (RESOLVEDBY_PREDICATE_MODAL.test(claim.slice(mention.index + mention[0].length))) return true;
  if (RESOLVEDBY_FUTURE_SUBORDINATE_PREFIX.test(prefix)) return true;
  return isGovernedObject(prefix) && RESOLVEDBY_GOVERNING_FUTURE.test(prefix);
}

/**
 * [F18-43] The part of a claim still to be judged as a claim about resolvedBy:
 * the whole claim unless its quantified mention is metalinguistic by its
 * predicate, the coordinated remainder after a text-analysis predicate, or
 * null when the mention is only the analysed object.
 */
function claimAfterMetalinguisticMention(claim: string): string | null {
  const phrase = RESOLVEDBY_METALINGUISTIC_MENTION.exec(claim);
  if (phrase === null) return claim;
  const predicate = claim.slice(phrase.index + phrase[0].length).replace(/^[^a-z]+/, '');
  const afterModifier = predicate.replace(META_LOCATIVE_POST_MODIFIER, '');
  const analysis = META_TEXT_ANALYSIS_PREDICATE.exec(afterModifier);
  if (analysis !== null) {
    const rest = afterModifier.slice(analysis[0].length).replace(/^[^a-z]*(?:(?:and|or|nor|then|but)\b\s*)?/, '');
    return /[a-z]/.test(rest) ? `resolvedby ${rest}` : null;
  }
  const [first = '', second = ''] = wordsOf(afterModifier);
  if (isFiniteVerbStart(first, second)) return claim;
  const prefix = claim.slice(0, phrase.index);
  const governed = META_ANALYSIS_GOVERNORS.has(wordsOf(prefix).pop() ?? '') || META_CONTAINS_QUESTION.test(prefix);
  // A comma-set (non-restrictive) relative asserts its predicate of the
  // mention instead of restricting which mentions are analysed.
  const nonRestrictive = /^[^a-z]*,/.test(claim.slice(phrase.index + phrase[0].length));
  const modifierOnly = !nonRestrictive && (afterModifier.length === 0 || META_POST_MODIFIER_OPENERS.has(wordsOf(predicate)[0] ?? ''));
  return governed && modifierOnly ? null : claim;
}

function isUnsafeResolvedByClaim(localClaim: string): boolean {
  const claim = claimAfterMetalinguisticMention(localClaim);
  if (claim === null) return false;
  const concept = RESOLVEDBY_CONCEPT.exec(claim);
  if (concept === null) return false;
  if (RESOLVEDBY_NEGATION.test(claim.slice(0, concept.index))) return false;
  if (RESOLVEDBY_PRESENT_ANCHOR.test(claim)) return true;
  return !hasGoverningFutureEvidence(claim);
}

function isFiniteVerbStart(first: string, second: string): boolean {
  if (FINITE_AUXILIARY.has(first)) return true;
  return /(?:s|ed)$/.test(first) && (OBJECT_OPENERS.has(second) || PARTICIPLE_CONCEPT.test(second));
}

function opensWithExplicitSubject(first: string, second: string): boolean {
  if (SUBJECT_DETERMINERS.has(first) || SUBJECT_PRONOUNS.has(first) || DEMONSTRATIVES.has(first)) return true;
  if (INVERSION_AUXILIARY.has(first) && (SUBJECT_DETERMINERS.has(second) || SUBJECT_PRONOUNS.has(second) || DEMONSTRATIVES.has(second) || second === 'it')) return true;
  return !isFiniteVerbStart(first, second);
}

/**
 * [F18-42] The clause re-read with resolvedBy as its subject, or null when it
 * opens with its own explicit subject. Analysis only -- source text is never
 * rewritten.
 */
function impliedResolvedByClaim(segment: string): string | null {
  const subordinate = CONTINUATION_SUBORDINATE.exec(segment)?.[0] ?? '';
  let rest = segment.slice(subordinate.length);
  let filler = '';
  for (let match = CONTINUATION_FILLER.exec(rest); match !== null && match[0].length > 0; match = CONTINUATION_FILLER.exec(rest)) {
    filler += match[0];
    rest = rest.slice(match[0].length);
  }
  const [first = '', second = '', third = ''] = wordsOf(rest);
  if (first === 'it' || (DEMONSTRATIVES.has(first) && isFiniteVerbStart(second, third))) {
    return `${subordinate}resolvedby ${filler}${rest.replace(/^(?:it|this|that)\b\s*/, '')}`;
  }
  if (opensWithExplicitSubject(first, second)) return null;
  return `${subordinate}resolvedby ${filler}${rest}`;
}

/** Every local `resolvedBy` claim that reads as an unqualified present-tense identity claim; empty means safe. */
function findUnsafeResolvedByClaims(text: string): readonly string[] {
  const results: string[] = [];
  for (const unitSegments of splitIntoSegmentsByUnit(text)) {
    let previousClauseHadSubject = false;
    for (const segment of unitSegments) {
      let claims = splitIntoMentionClaims(segment);
      if (claims.length === 0 && previousClauseHadSubject) {
        const implied = impliedResolvedByClaim(segment);
        claims = implied === null ? [] : splitIntoMentionClaims(implied);
      }
      results.push(...claims.filter(isUnsafeResolvedByClaim));
      previousClauseHadSubject = claims.length > 0;
    }
  }
  return results;
}

describe('P18 import graph is well-formed', () => {
  it('discovers the reconciliation tree and its integration adapter', () => {
    expect(reconciliationFiles.length).toBeGreaterThanOrEqual(8);
    expect(files).toContain('src/execution/live/reconciliation/service.ts');
    expect(files).toContain('src/execution/live/reconciliation/repository.ts');
    expect(files).toContain('src/execution/live/reconciliation/barrier.ts');
    expect(files).toContain(EVIDENCE_ADAPTER);
  });

  it('resolves every relative import in the repository', () => {
    expect(unresolved).toEqual([]);
  });
});

describe('P18-§20 reconciliation depends on narrow ports, never on raw network or credentials', () => {
  it('no reconciliation file reaches ANY integration module, not even a type-only one', () => {
    for (const file of reconciliationFiles) {
      const violation = findPath(graph, file, (node) => node.startsWith('src/integration/'));
      expect(violation, `forbidden dependency path: ${(violation ?? []).join(' -> ')}`).toBeNull();
    }
  });

  it('no reconciliation file reaches the mutable order transport or its adapter', () => {
    for (const file of reconciliationFiles) {
      for (const target of [MUTATION_TRANSPORT, MUTATION_ADAPTER, APPROVED_ROOT]) {
        const reachable = computeReachable(graph, file);
        expect(reachable.has(target), `${file} reaches ${target}`).toBe(false);
      }
    }
  });

  it('no reconciliation file imports an HTTP client, a socket, or a signing primitive', () => {
    const FORBIDDEN = ['node:http', 'node:https', 'node:net', 'node:tls', 'axios', 'node-fetch', 'undici', './signer', 'HmacSha256Signer'];
    for (const file of reconciliationFiles) {
      const code = codeOf(file);
      for (const forbidden of FORBIDDEN) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it('no reconciliation file names a CoinDCX endpoint path or auth header', () => {
    for (const file of reconciliationFiles) {
      const code = codeOf(file);
      for (const forbidden of ['/exchange/v1', 'api.coindcx.com', 'X-AUTH-APIKEY', 'X-AUTH-SIGNATURE']) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it('no reconciliation file reads a credential out of configuration', () => {
    for (const file of reconciliationFiles) {
      const code = codeOf(file);
      for (const forbidden of ['COINDCX_API_KEY', 'COINDCX_API_SECRET', 'apiSecret', 'apiKey']) {
        expect(code.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it('the reconciliation barrel reaches no integration module', () => {
    for (const node of computeReachable(graph, 'src/execution/live/reconciliation/index.ts')) {
      expect(node.startsWith('src/integration/'), `barrel reaches ${node}`).toBe(false);
    }
  });
});

describe('P18-§9/§20 Phase18 adds no second mutation owner', () => {
  it('the ONLY orphan-cancellation implementation delegates to the Phase17 gateway port', () => {
    const adapter = 'src/execution/live/reconciliation/gateway-orphan-cancellation.ts';
    const code = codeOf(adapter);
    // It depends on the PORT type and calls the port's own method. It cannot
    // construct a transport, because it never names one.
    expect(code).toContain('CoinDcxFuturesOrderGateway');
    expect(code).toContain('cancelOrder');
    expect(code).not.toContain('CoinDcxOrderMutationTransport');
    expect(code).not.toContain('CoinDcxLiveFuturesOrderGateway');

    const reachable = computeReachable(graph, adapter);
    expect(reachable.has('src/execution/live/gateway.ts')).toBe(true);
    expect(reachable.has(MUTATION_ADAPTER)).toBe(false);
    expect(reachable.has(MUTATION_TRANSPORT)).toBe(false);
  });

  it('keeps the Phase17 rule that only the approved root reaches the mutable adapter', () => {
    const reachers = files.filter((file) => file !== MUTATION_ADAPTER && computeReachable(graph, file).has(MUTATION_ADAPTER));
    expect(reachers).toEqual([APPROVED_ROOT]);
  });

  it('keeps the approved production root an explicit opt-in entry point nothing imports', () => {
    const reachers = files.filter((file) => file !== APPROVED_ROOT && computeReachable(graph, file).has(APPROVED_ROOT));
    expect(reachers).toEqual([]);
  });

  it('the evidence adapter is READ-ONLY: it reaches the read client and no mutation surface', () => {
    const reachable = computeReachable(graph, EVIDENCE_ADAPTER);
    expect(reachable.has('src/integration/coindcx/client.ts')).toBe(true);
    expect(reachable.has(MUTATION_ADAPTER)).toBe(false);
    expect(reachable.has(MUTATION_TRANSPORT)).toBe(false);
    const code = codeOf(EVIDENCE_ADAPTER);
    for (const forbidden of ['cancelOrder', 'placeOrder', 'createOrder', 'orders/create', 'orders/cancel']) {
      expect(code.includes(forbidden), `evidence adapter names ${forbidden}`).toBe(false);
    }
  });

  it('adds no new signing site anywhere in the repository', () => {
    const signers = files.filter((file) => sourceOf(file).includes('X-AUTH-SIGNATURE'));
    expect(signers.sort()).toEqual([
      'src/integration/coindcx/live/endpoints.ts',
      'src/integration/coindcx/live/mutation-transport.ts',
      'src/integration/coindcx/transport.ts',
    ]);
  });
});

describe('P18-§19 paper/live isolation is preserved', () => {
  const paperFiles = files.filter((file) => file.startsWith('src/execution/') && !file.startsWith('src/execution/live/'));

  it('discovers the Phase14 paper execution tree', () => {
    expect(paperFiles.length).toBeGreaterThanOrEqual(20);
    expect(paperFiles).toContain('src/execution/persistence/paper-account-reconciler.ts');
  });

  it('no paper execution file reaches the Phase18 reconciliation tree', () => {
    for (const file of paperFiles) {
      const violation = findPath(graph, file, (node) => node.startsWith(RECONCILIATION_ROOT));
      expect(violation, `forbidden dependency path: ${(violation ?? []).join(' -> ')}`).toBeNull();
    }
  });

  it('the paper production runtime cannot reach reconciliation or live mutation', () => {
    const paperRoot = 'src/integration/coindcx/paper-production-runtime.ts';
    expect(files).toContain(paperRoot);
    const reachable = computeReachable(graph, paperRoot);
    for (const node of reachable) {
      expect(node.startsWith(RECONCILIATION_ROOT), `paper runtime reaches ${node}`).toBe(false);
    }
    expect(reachable.has(MUTATION_ADAPTER)).toBe(false);
  });

  it('no upstream analytical layer reaches reconciliation', () => {
    for (const prefix of ['src/strategies/', 'src/research/', 'src/ranking/', 'src/risk/', 'src/dispatch/', 'src/backtest/', 'src/market-data/']) {
      for (const file of files.filter((candidate) => candidate.startsWith(prefix))) {
        const violation = findPath(graph, file, (node) => node.startsWith(RECONCILIATION_ROOT));
        expect(violation, `forbidden dependency path: ${(violation ?? []).join(' -> ')}`).toBeNull();
      }
    }
  });

  it('the paper reconciler and the live reconciler share no module', () => {
    const paperReconciler = computeReachable(graph, 'src/execution/persistence/paper-account-reconciler.ts');
    expect([...paperReconciler].some((node) => node.startsWith(RECONCILIATION_ROOT))).toBe(false);
  });
});

describe('P18-§22 reconciliation is pair-generic', () => {
  // Deliberately a WORD-BOUNDARY scan: a comment is already stripped, and this
  // must not fire on an unrelated substring inside an identifier.
  const COIN_TOKENS = [/\bBTC\b/, /\bETH\b/, /\bSOL\b/, /\bXRP\b/, /\bDOGE\b/, /B-[A-Z]+_USDT/];

  it('contains no coin-specific executable logic', () => {
    for (const file of [...reconciliationFiles, EVIDENCE_ADAPTER]) {
      const code = codeOf(file);
      for (const token of COIN_TOKENS) {
        expect(token.test(code), `${file} contains coin-specific logic matching ${token}`).toBe(false);
      }
    }
  });

  it('branches on no hardcoded pair list', () => {
    for (const file of reconciliationFiles) {
      const code = codeOf(file);
      expect(/pair\s*===\s*['"]/.test(code), `${file} compares a pair against a literal`).toBe(false);
    }
  });
});

describe('P18-§25 tests cannot reach a real venue', () => {
  function listTestFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { results.push(...listTestFiles(path.join(dir, entry.name))); continue; }
      if (entry.isFile() && entry.name.endsWith('.ts')) results.push(path.join(dir, entry.name));
    }
    return results.sort();
  }

  const SELF = 'phase18-reconciliation-boundary.test.ts';
  const testFiles = listTestFiles(TESTS_ROOT).filter((file) => path.basename(file) !== SELF);
  const phase18Tests = testFiles.filter((file) => file.includes('reconciliation') && !file.includes('paper-account-reconciler'));

  it('discovers the Phase18 test suites', () => {
    expect(phase18Tests.length).toBeGreaterThanOrEqual(4);
  });

  it('no Phase18 test constructs a real order gateway, transport, or evidence adapter', () => {
    // The forbidden constructor expressions are ASSEMBLED rather than written
    // out, because the sibling Phase17 boundary test scans every test file for
    // exactly these literals. Writing them here verbatim would make this file
    // trip that scanner on its own assertion text — a false positive, since an
    // assertion literal is not a construction. Assembling them keeps the
    // Phase17 scan maximally strict with no exclusion added for this file.
    const NEW = 'new ';
    for (const file of phase18Tests) {
      const source = readFileSync(file, 'utf8');
      for (const className of [
        'CoinDcxLiveFuturesOrderGateway',
        'CoinDcxOrderMutationTransport',
        'CoinDcxReconciliationEvidenceAdapter',
        'CoinDcxClient',
      ]) {
        const forbidden = `${NEW}${className}`;
        if (className === 'CoinDcxReconciliationEvidenceAdapter'
            && file.endsWith(path.join('unit', 'execution', 'live', 'reconciliation', 'wave-a-authority.test.ts'))) {
          expect(source).toContain('client: client as never');
          expect(source).not.toContain(`${NEW}CoinDcxClient`);
          continue;
        }
        expect(source.includes(forbidden), `${path.relative(REPO_ROOT, file)} constructs ${forbidden}`).toBe(false);
      }
    }
  });

  it('no Phase18 test names the production CoinDCX host', () => {
    for (const file of phase18Tests) {
      expect(readFileSync(file, 'utf8')).not.toContain('api.coindcx.com');
    }
  });

  it('no Phase18 test imports the production runtime or its composer', () => {
    const IMPORTS_RUNTIME = /(?:from\s*|require\(\s*)['"][^'"]*live\/production-runtime['"]/;
    for (const file of phase18Tests) {
      const source = readFileSync(file, 'utf8');
      if (file.endsWith(path.join('integration', 'execution', 'live-reconciliation-persistence.integration.test.ts'))) {
        expect(source).toContain('FakeOrderGateway');
        expect(source).toContain('FakeEvidenceProvider');
        expect(source).not.toContain(`${'new '}CoinDcxLiveFuturesOrderGateway`);
        continue;
      }
      expect(IMPORTS_RUNTIME.test(source), `${path.relative(REPO_ROOT, file)} imports the production runtime`).toBe(false);
      expect(source.includes('composeLiveExecutionRuntime')).toBe(false);
    }
  });

  it('the orphan-cancellation fake records attempts instead of making them', () => {
    const helpers = readFileSync(path.join(TESTS_ROOT, 'unit/execution/live/reconciliation/helpers.ts'), 'utf8');
    expect(helpers).toContain('class FakeOrphanCancellation');
    expect(helpers).toContain('this.attempts.push');
    expect(helpers).not.toContain('node:http');
  });
});

describe('P18-§18 the barrier is wired into the production live path', () => {
  const runtime = codeOf(APPROVED_ROOT);

  it('gates create, cancel, and close on current reconciliation', () => {
    expect(runtime).toContain('requireCurrentReconciliation');
    expect(runtime).toContain("this.#requireReconciled(request.accountId, 'CREATE')");
    expect(runtime).toContain("this.#requireReconciled(request.accountId, 'CLOSE')");
    expect(runtime).toContain("'CANCEL'");
  });

  it('keeps CLOSE dependent on BOTH the barrier and Phase17 position ownership', () => {
    const closeBody = runtime.slice(runtime.indexOf('public async closeLive'), runtime.indexOf('public async cancelLive'));
    expect(closeBody).toContain('#requireReconciled');
    expect(closeBody).toContain('requireAuthoritativeLivePosition');
  });

  it('does not weaken any existing Phase17 authority check', () => {
    // The barrier is ADDITIVE: every Phase17 mint and gate is still called.
    expect(runtime).toContain('mintLiveOpenExecutionAuthority');
    expect(runtime).toContain('mintLiveCloseExecutionAuthority');
    expect(runtime).toContain('resolveLiveExecutionGate');
    expect(runtime).toContain('requireAuthoritativeLivePosition');
  });

  it('defaults orphan cancellation to disabled at the composition root', () => {
    expect(runtime).toContain('resolveOrphanCleanupPolicy');
    // The capability is constructed ONLY inside the enabled branch.
    expect(runtime).toContain("orphanResolution.status === 'ENABLED'");
    expect(runtime).toContain('GatewayOrphanCancellation');
  });

  it('[Wave C2 / F18-10] reads the per-run orphan cancellation ceiling in exactly one place', () => {
    // One authoritative parser: no second call site may re-convert the raw
    // configuration string with its own `Number`/`parseInt`.
    const readers = files.filter((file) => codeOf(file).includes('LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN'));
    expect(readers).toEqual(['src/execution/live/reconciliation/orphan-policy.ts']);
    expect(codeOf('src/execution/live/reconciliation/orphan-policy.ts')).not.toMatch(/parseInt|parseFloat|\+\s*raw/);
  });

  it('[Wave C4 / F18-45] documents the fail-closed ambiguous-create rule and scopes the barrier to normal mutation', () => {
    const architecture = readFileSync(path.join(REPO_ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
    const phase18Section = architecture.slice(architecture.indexOf('### 2.21 Reconciliation & Crash Recovery (Phase 18)'));
    // Missing TIF refuses adoption outright; it never merely "widens matching".
    expect(phase18Section).toContain('RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE');
    expect(phase18Section).not.toMatch(/widens matching/);
    expect(phase18Section).toContain('not normal trading authority');
    // The barrier's own comments name normal Phase 17 mutation, because the
    // reconciliation-owned orphan cancellation path never passes it.
    expect(sourceOf('src/execution/live/reconciliation/barrier.ts')).not.toMatch(/every live mutation/);
    expect(codeOf('src/execution/live/reconciliation/gateway-orphan-cancellation.ts')).not.toContain('requireCurrentReconciliation');
    expect(codeOf('src/execution/live/reconciliation/service.ts')).not.toContain('requireCurrentReconciliation');
  });

  it('[Wave B5 / F18-28] calls requireCurrentReconciliation with exactly its 4 real arguments, never a 5th', () => {
    // A textual proof, deliberately alongside the type-system one
    // (`requireCurrentReconciliation` no longer even HAS a 5th parameter):
    // the one production call site never had a reason to pass one, and this
    // pins that it still does not, so a future edit re-adding a caller-
    // suppliable continuity argument here would fail this test even if the
    // function signature were ever loosened again.
    const callSite = runtime.slice(runtime.indexOf('return requireCurrentReconciliation('));
    const call = callSite.slice(0, callSite.indexOf(');') + 2);
    expect(call).toBe('return requireCurrentReconciliation(this.#reconciliationRepository, accountId, this.#runtimeIdentity, mutation);');
  });
});

describe('P18-§24 F18-24: no absolute, unsupported claim about what the CoinDCX provider contract can never return', () => {
  // [Wave B4 / F18-24, closed again Wave B5] Independent review found this
  // exact overclaim pattern TWICE: once in Wave B3's original TIF wording,
  // and again in Wave B4's own "corrected" wording, which fixed every
  // instance EXCEPT one in `order-reconciliation.ts`. This is now a
  // permanent architectural check, not a one-time grep, specifically because
  // the mistake recurred once already. Every phrase below has been verified
  // absent from this codebase's CURRENT (corrected) wording, including its
  // own negations — e.g. "not... structurally incapable of ever returning
  // one" uses "incapable", never "impossible", and "not an assertion about
  // ...under every circumstance" uses "every", never "any" — so this is a
  // plain substring ban with no legitimate current use to avoid.
  const FORBIDDEN_PHRASES = [
    'never returns',
    'never carries',
    'never carry',
    'structurally impossible',
    'under any circumstance',
    'cannot return',
    'can never return',
  ] as const;

  const RELEVANT_FILES = [
    ...reconciliationFiles,
    'src/integration/coindcx/live/wire-schemas.ts',
    'src/integration/coindcx/live/reconciliation-evidence-adapter.ts',
  ];

  it.each(RELEVANT_FILES)('%s', (file) => {
    const lowerSource = sourceOf(file).toLowerCase();
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(lowerSource.includes(phrase)).toBe(false);
    }
  });

  it('the historical record of the earlier overclaim in the docs is clearly framed as a corrected quotation, not a live claim', () => {
    // The doc legitimately QUOTES the old, wrong wording while explaining the
    // correction (§8.2, §21) — this test does not ban the phrase from the
    // doc (that would erase the record of the mistake), it only pins that
    // every quotation is textually adjacent to a correction marker, so a
    // reader (or a future editor) cannot mistake it for current guidance.
    const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE18_RECONCILIATION.md'), 'utf8');
    const overclaimPattern = /never returns TIF|never carries one|never carries a|never return one/gi;
    let match: RegExpExecArray | null;
    let found = 0;
    while ((match = overclaimPattern.exec(doc)) !== null) {
      found += 1;
      const windowStart = Math.max(0, match.index - 400);
      const window = doc.slice(windowStart, match.index);
      expect(/overstat|overclaim|correct|earlier text|wrong|F18-24/i.test(window)).toBe(true);
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('P18-§F18-31 resolvedBy is never described as an authenticated operator identity', () => {
  // [Wave C1.1 / F18-31] `resolvedBy` (orphan-resolution.ts) is a
  // caller-asserted audit label, not an authenticated identity -- no
  // operator-auth transport exists in this phase. This is a permanent
  // architectural check, not a one-time review note, mirroring the F18-24
  // block above: it bans the specific overclaim phrasing outright, since the
  // CORRECT wording never needs any of these phrases (it says "does not
  // authenticate an operator identity", never "authenticated operator
  // identity" or "verified operator").
  // Deliberately affirmative-only phrasing: the CORRECT disclaimer wording
  // legitimately contains the words "authenticated operator identity" inside
  // a NEGATION ("NOT an authenticated operator identity", "NOT proof that an
  // authenticated operator approved..."), so banning that substring bare
  // would forbid the very sentence this check exists to require. Each phrase
  // below instead only matches the AFFIRMATIVE claim form, which has no
  // legitimate use regardless of surrounding context.
  const FORBIDDEN_PHRASES = [
    'resolvedby is authenticated',
    'is an authenticated operator identity',
    'is a verified operator identity',
    'is an authenticated operator',
    'as proof of an authenticated operator',
    'proves that an authenticated operator',
  ] as const;

  const RELEVANT_FILES = [
    'src/execution/live/reconciliation/orphan-resolution.ts',
    'src/execution/live/reconciliation/ports.ts',
    'src/execution/live/reconciliation/repository.ts',
  ];

  it.each(RELEVANT_FILES)('%s', (file) => {
    const lowerSource = sourceOf(file).toLowerCase();
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(lowerSource.includes(phrase)).toBe(false);
    }
  });

  it('docs/PHASE18_RECONCILIATION.md never claims resolvedBy is an authenticated operator identity', () => {
    const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE18_RECONCILIATION.md'), 'utf8').toLowerCase();
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(doc.includes(phrase)).toBe(false);
    }
  });

  it('orphan-resolution.ts states plainly that resolvedBy is caller-asserted, not authenticated', () => {
    const source = sourceOf('src/execution/live/reconciliation/orphan-resolution.ts');
    expect(source).toContain('caller-asserted audit label');
    expect(source).toMatch(/does not authenticate an operator identity/i);
  });
});

describe('P18-§F18-33 findUnsafeResolvedByClaims: the guard itself, tested adversarially', () => {
  // [Wave C1.3 / F18-34, F18-35, F18-36] The exact-phrase ban above
  // (P18-§F18-31) is a cheap first layer; this proves the SECOND layer --
  // now sentence/clause-scoped reasoning, not a shared character window --
  // correctly separates false claims from legitimate negations and
  // legitimate future-transport design statements, INCLUDING when a safe
  // clause sits right next to an unsafe one in the same sentence or the same
  // text. "Do not rely only on the current real source text": every case
  // here is synthetic, not lifted from any real file.

  // [F18-34] 14 unsafe affirmative current claims, covering the expanded
  // concept vocabulary (authenticated, verified, trusted, authorized/
  // authorised, approved, principal, user, administrator, approver) that the
  // original narrow "authorized operator"-only phrase list missed.
  const UNSAFE_CURRENT_CLAIMS = [
    'resolvedBy is populated from the authorized user',
    'resolvedBy stores the authenticated user',
    'resolvedBy identifies the verified operator',
    'resolvedBy is the authenticated operator identity',
    'resolvedBy records the trusted operator',
    'resolvedBy contains the authorized operator identity',
    'resolved_by is a verified principal',
    'resolvedBy names the verified human who resolved the orphan',
    'resolvedBy represents a trusted administrator',
    'the operator recorded in resolvedBy has been authenticated',
    'resolved_by proves the approving principal',
    'resolvedBy contains the approved administrator',
    'resolvedBy stores the authorized principal',
    'resolvedBy identifies the authenticated approver',
  ];

  // [F18-34 §9] 8 legitimate negations -- negation must apply within the
  // same clause as the concept word, not merely appear somewhere in the file.
  const LEGITIMATE_NEGATIONS = [
    'resolvedBy is not authenticated',
    'resolvedBy is not a verified operator identity',
    'resolvedBy does not prove operator identity',
    'resolvedBy does not identify an authenticated user',
    'resolvedBy must never be treated as proof of an authenticated principal',
    'resolvedBy is only a caller-asserted audit label',
    'resolvedBy is not evidence that the operator was authorized',
    'Wave C1 does not authenticate an operator',
  ];

  // [F18-35 §10] 7 legitimate future-design statements -- the guard must
  // recognize these describe a FUTURE design, not a current guarantee.
  const LEGITIMATE_FUTURE_DESIGN = [
    'a future transport must authenticate the operator',
    'future transport must derive resolvedBy from the trusted principal',
    'future authenticated transport should populate resolvedBy from its trusted principal',
    'future authenticated transport must derive resolvedBy from its authenticated principal',
    'once authentication exists, resolvedBy should be derived from the authenticated principal',
    'when a protected operator transport is added, resolvedBy must come from the authenticated user',
    'a future authorized admin transport should derive resolvedBy from the trusted operator identity',
  ];

  // [F18-35 §11] 3 mixed current/future sentences -- must not be rejected
  // merely because authentication words appear somewhere in the sentence.
  const MIXED_CURRENT_FUTURE_SAFE = [
    'resolvedBy is currently caller-asserted; a future authenticated transport must derive it from the trusted principal.',
    'resolvedBy is not authenticated today; once authentication exists, it should be populated from the authenticated principal.',
    'currently resolvedBy is only an audit label, while a future operator transport must derive it from the authorized user.',
  ];

  // [F18-36 §12] 3 cross-sentence laundering cases -- a safe/future/negative
  // sentence must never excuse a SEPARATE unsafe affirmative sentence
  // elsewhere in the same text.
  const CROSS_SENTENCE_LAUNDERING_UNSAFE = [
    'A future transport must authenticate the operator.\nresolvedBy currently identifies the verified operator.',
    'resolvedBy will be derived from a trusted principal in the future.\nresolvedBy currently stores the authenticated user.',
    'resolvedBy is not authenticated in one workflow.\nresolvedBy identifies the verified operator in the current resolution flow.',
  ];

  // [F18-36 §13] 2 same-sentence contradictory-clause cases -- one safe
  // clause must never launder a different unsafe clause joined by
  // "but"/"however" in the SAME sentence.
  const SAME_SENTENCE_CONTRADICTION_UNSAFE = [
    'resolvedBy is caller-asserted, but resolvedBy identifies the verified operator.',
    'resolvedBy is not authenticated, however resolvedBy stores the authorized user.',
  ];

  it.each(UNSAFE_CURRENT_CLAIMS)('[F18-34] flags an unqualified current authentication/verification/trust/authorization claim: %s', (claim) => {
    expect(findUnsafeResolvedByClaims(claim)).not.toEqual([]);
  });

  it.each(LEGITIMATE_NEGATIONS)('[F18-34] does not flag a legitimate same-clause negation: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  it.each(LEGITIMATE_FUTURE_DESIGN)('[F18-35] does not flag a legitimate future-design statement: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  it.each(MIXED_CURRENT_FUTURE_SAFE)('[F18-35 §11] does not flag a legitimate current-vs-future contrast sentence: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  it.each(CROSS_SENTENCE_LAUNDERING_UNSAFE)('[F18-36 §12] a safe/future sentence never launders a separate unsafe sentence: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(SAME_SENTENCE_CONTRADICTION_UNSAFE)('[F18-36 §13] a safe clause never launders a contradictory unsafe clause in the same sentence: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it('is not fooled by a negation planted in an entirely separate sentence from a later unrelated claim', () => {
    // The Wave C1.2 shared-window version of this test relied on padding
    // text to push the claim outside a fixed character radius. The
    // sentence/clause-scoped version needs no padding at all: a negation in
    // one SENTENCE structurally cannot reach a claim in a later sentence,
    // regardless of distance.
    const laundered = 'resolvedBy is not a fabricated field. Separately, resolvedBy is the authenticated operator identity beyond any doubt.';
    expect(findUnsafeResolvedByClaims(laundered)).not.toEqual([]);
  });

  // [Wave C1.4 / F18-37] Qualifier laundering through boundaries C1.3 did not
  // recognize: colon, dashes, parentheticals, further contrastive transitions,
  // several mentions in one segment, a trailing negation, and a future marker
  // overridden by an explicit present-tense anchor.
  const F18_37_UNSAFE: Readonly<Record<string, readonly string[]>> = {
    colon: [
      'resolvedBy is not authenticated: resolvedBy stores the authorized user',
      'future transport must authenticate the operator: resolvedBy currently identifies the verified operator',
      'resolvedBy is not authenticated for transport A: resolvedBy identifies the verified operator for this resolution',
    ],
    dash: [
      'resolvedBy is not authenticated — resolvedBy stores the authorized user',
      'resolvedBy is not authenticated – resolvedBy stores the authorized user',
      'resolvedBy is not authenticated - resolvedBy stores the authorized user',
      'resolvedBy may come from a trusted principal in the future — resolvedBy currently stores the authenticated user',
      'a future transport will authenticate — resolvedBy identifies the verified operator',
    ],
    conjunction: [
      'resolvedBy is caller-asserted, yet resolvedBy identifies the verified operator',
      'resolvedBy is caller-asserted, although resolvedBy records the trusted administrator',
      'resolvedBy is caller-asserted, though resolvedBy stores the authenticated user',
      'resolvedBy is caller-asserted, nevertheless resolvedBy identifies the authorized principal',
      'resolvedBy is caller-asserted; on the other hand, resolvedBy stores the verified admin',
      'resolvedBy is not proof of identity, yet resolvedBy records the authorized user',
    ],
    parenthetical: [
      'resolvedBy is not authenticated (resolvedBy stores the authorized user)',
      'resolvedBy is caller-asserted, but (resolvedBy identifies the verified operator)',
      'resolvedBy is caller-asserted (resolvedBy identifies the verified operator)',
      'resolvedBy (the audit label) stores the authenticated user',
    ],
    multipleMentions: [
      'resolvedBy is not authenticated, resolvedBy stores the authorized user',
      'resolvedBy is caller-asserted and resolvedBy identifies the verified operator',
    ],
    locality: [
      'resolvedBy identifies the verified operator, not the account',
      'future transport must authenticate the operator, resolvedBy currently identifies the verified operator',
    ],
  };

  const F18_37_SAFE: Readonly<Record<string, readonly string[]>> = {
    plain: [
      'resolvedBy is not authenticated',
      'resolvedBy is caller-asserted',
      'resolvedBy does not prove operator identity',
      'resolvedBy is not evidence of an authorized user',
      'resolvedBy does not identify an authenticated operator',
    ],
    future: [
      'future authenticated transport must derive resolvedBy from the trusted principal',
      'once authentication exists, resolvedBy should come from the authenticated principal',
      'future transport must authenticate the operator and derive resolvedBy from that trusted principal',
      'once authentication exists, resolvedBy should be populated from the authenticated user',
    ],
    boundary: [
      'resolvedBy is caller-asserted today: a future authenticated transport must derive it from a trusted principal',
      'resolvedBy is not authenticated today — once authentication exists, it should come from the authenticated principal',
    ],
    parenthetical: [
      'resolvedBy is caller-asserted (not authenticated)',
      'resolvedBy is not authenticated (future transport must derive it from the trusted principal)',
    ],
    coordinated: [
      'resolvedBy and resolved_by are not authenticated',
      'neither resolvedBy nor resolved_by is authenticated',
    ],
  };

  for (const [group, cases] of Object.entries(F18_37_UNSAFE)) {
    it.each(cases)(`[F18-37 ${group}] flags a laundered unsafe claim: %s`, (wording) => {
      expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
    });
  }

  for (const [group, cases] of Object.entries(F18_37_SAFE)) {
    it.each(cases)(`[F18-37 ${group}] does not flag legitimate wording: %s`, (wording) => {
      expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
    });
  }

  // [Wave C1.5 / F18-38] A single resolvedBy mention let an unrelated LEADING
  // clause (no resolvedBy mention of its own) launder a separate, present-
  // tense resolvedBy claim joined only by a plain comma -- because the whole
  // undivided segment was treated as one claim, so the leading clause's own
  // concept word and "future" marker excused the real resolvedBy assertion.
  const F18_38_UNSAFE_COMMA_SCOPING = [
    'A future transport must authenticate the operator, resolvedBy identifies the verified operator today.',
    'A future transport must authenticate the operator, resolvedBy identifies the verified operator now.',
    'A future transport must authenticate the operator, resolvedBy identifies the verified operator in the current implementation.',
    "A future transport must authenticate the operator, resolvedBy stores the authorized user in today's system.",
    'Future authentication will be added later, resolvedBy identifies the trusted administrator today.',
    'Future authorization may exist later, resolvedBy stores the authenticated operator now.',
    'The future dashboard will authenticate administrators, resolvedBy currently identifies the authorized user.',
    'Authentication is planned for a future CLI, resolvedBy records the verified principal in this system.',
  ];

  // A leading clause that genuinely GOVERNS the resolvedBy mention (joined by
  // and/or/nor/then, no comma break at all, or a once/exists or when/added
  // subordinate clause) must still excuse it -- this is the required
  // counter-matrix distinguishing a real future design statement from an
  // unrelated future statement bolted onto a present false claim.
  const F18_38_SAFE_FUTURE_DESIGN_COMMA = [
    'A future transport must authenticate the operator, and resolvedBy should then identify that authenticated principal.',
    'When authentication is added, resolvedBy will be populated from the authorized user.',
    'In a future protected transport, resolvedBy will represent the authenticated principal.',
    'Once authentication exists, resolvedBy should be derived from the trusted principal.',
    'Future transport must authenticate the operator and derive resolvedBy from that trusted principal.',
  ];

  it.each(F18_38_UNSAFE_COMMA_SCOPING)('[F18-38] an unrelated leading clause does not launder a comma-joined present-tense claim: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_38_SAFE_FUTURE_DESIGN_COMMA)('[F18-38] a leading clause that genuinely governs the mention still excuses it: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  // [Wave C1.5 / F18-39] A contrastive/continuation clause with an elided
  // resolvedBy subject (no literal `resolvedBy`/`resolved_by` token) was
  // dropped entirely -- zero claims, never evaluated -- instead of inheriting
  // the nearest preceding resolvedBy subject.
  const F18_39_UNSAFE_IMPLIED_SUBJECT = [
    'resolvedBy is caller-asserted, but identifies the verified operator',
    'resolvedBy is not authenticated, yet stores the authorized user',
    'resolvedBy is only an audit label; however it identifies the trusted administrator',
    'resolvedBy is caller-asserted, although records the authenticated user',
    'resolvedBy is not verified, nevertheless names the authorized principal',
    'resolvedBy is only metadata, while identifies the trusted operator',
    'resolvedBy is not proof of identity, whereas stores the verified admin',
  ];

  // The same elision across a STRONG boundary (colon/dash/semicolon) rather
  // than a contrastive-transition word.
  const F18_39_UNSAFE_STRONG_SEPARATOR = [
    'resolvedBy is caller-asserted: identifies the verified operator',
    'resolvedBy is not authenticated — stores the authorized user',
    'resolvedBy is only an audit label; records the trusted administrator',
  ];

  // A continuation clause with its OWN explicit subject must NEVER inherit
  // resolvedBy, however future-related its own subject is.
  const F18_39_SAFE_EXPLICIT_NEW_SUBJECT = [
    'resolvedBy is caller-asserted, but the future transport will authenticate the operator',
    'resolvedBy is not authenticated; the future API will derive the label from a trusted principal',
    'resolvedBy is only an audit label, while operator authentication belongs to a future transport',
    'resolvedBy is not verified today; authentication will exist only in a future admin service',
  ];

  const F18_39_UNSAFE_PRONOUN_CONTINUATION = [
    'resolvedBy is caller-asserted, but it identifies the verified operator',
    'resolvedBy is not authenticated, yet it stores the authorized user',
  ];

  const F18_39_SAFE_PRONOUN_CONTINUATION = [
    'resolvedBy is caller-asserted, but it will be derived from an authenticated principal once a future transport exists',
  ];

  it.each(F18_39_UNSAFE_IMPLIED_SUBJECT)('[F18-39] an elided-subject continuation inherits the resolvedBy claim: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_39_UNSAFE_STRONG_SEPARATOR)('[F18-39] an elided-subject continuation across a strong separator still inherits: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_39_SAFE_EXPLICIT_NEW_SUBJECT)('[F18-39] a continuation clause with its own explicit subject never inherits resolvedBy: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  it.each(F18_39_UNSAFE_PRONOUN_CONTINUATION)('[F18-39] a pronoun continuation with a present-tense claim inherits resolvedBy: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_39_SAFE_PRONOUN_CONTINUATION)('[F18-39] a pronoun continuation describing explicit future design remains safe: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  // [Wave C1.5] Targeted regression probes named directly by the independent
  // review: negation locality, future-marker locality, multiple resolvedBy
  // mentions, and parenthetical/dash/colon handling must all survive the
  // F18-38/F18-39 changes unchanged.
  it('[C1.5 regression] a leading negation never excuses an elided-subject continuation clause', () => {
    expect(findUnsafeResolvedByClaims('resolvedBy is not authenticated, but identifies the verified operator')).not.toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy is not proof of identity, yet stores the authorized user')).not.toEqual([]);
  });

  it('[C1.5 regression] a same-clause negation is unaffected by the F18-38/F18-39 changes', () => {
    expect(findUnsafeResolvedByClaims('resolvedBy does not identify an authenticated operator')).toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy does not store an authorized user identity')).toEqual([]);
  });

  it('[C1.5 regression] future-marker locality holds for both comma-scoping and implied-subject inheritance', () => {
    expect(findUnsafeResolvedByClaims('future transport must authenticate the operator, resolvedBy identifies the verified operator')).not.toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy may be derived from a trusted principal in the future, but currently identifies the verified operator')).not.toEqual([]);
    expect(findUnsafeResolvedByClaims('future transport must authenticate the operator, and resolvedBy should then identify that authenticated principal')).toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy will be derived from a trusted principal in the future')).toEqual([]);
  });

  it('[C1.5 regression] multiple resolvedBy mentions in one segment are unaffected by the F18-38 leading-clause change', () => {
    expect(findUnsafeResolvedByClaims('resolvedBy is not authenticated, resolvedBy stores the authorized user')).not.toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy is caller-asserted and resolvedBy identifies the verified operator')).not.toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy and resolved_by are not authenticated identities')).toEqual([]);
  });

  it('[C1.5 regression] parenthetical/dash/colon laundering from F18-37 remains closed', () => {
    expect(findUnsafeResolvedByClaims('resolvedBy is caller-asserted (resolvedBy identifies the verified operator)')).not.toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy is caller-asserted (not authenticated)')).toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy is not authenticated: resolvedBy stores the authorized user')).not.toEqual([]);
  });

  // [Wave C1.6 / F18-40] A connector word ("and"/"or"/"then") alone never lets
  // an unrelated leading clause govern a resolvedBy clause; only resolvedBy as
  // the OBJECT of a future-action verb does. Includes the C1.5 review's exact
  // reproducers (and-joined, no-comma, negation-prefix).
  const F18_40_UNSAFE_NEW_SUBJECT_CLAUSE = [
    'A future transport must authenticate the operator,\nand resolvedBy identifies the verified operator today.',
    'A future transport must authenticate the operator,\nand resolvedBy stores the authorized user now.',
    'A future transport may authenticate admins later,\nand resolvedBy identifies the trusted administrator in this system.',
    'Authentication will be added in the future,\nand resolvedBy records the verified principal today.',
    'The label is not signed,\nand resolvedBy identifies the verified operator.',
    'The label is not authenticated,\nand resolvedBy stores the authorized user.',
    'The future dashboard will authenticate users,\nor resolvedBy identifies the trusted operator today.',
    'Authentication may exist later,\nthen resolvedBy currently stores the verified administrator.',
    'A future transport must authenticate the operator and resolvedBy identifies the verified operator today.',
    'Future authentication will be added later and resolvedBy stores the authorized user now.',
    'Nothing is encrypted and resolvedBy stores the authenticated user.',
  ];

  const F18_40_SAFE_OBJECT_OF_FUTURE_VERB = [
    'A future transport must authenticate the operator\nand derive resolvedBy from the trusted principal.',
    'A future transport must authenticate the operator,\nthen derive resolvedBy from the trusted principal.',
    'A future transport should authorize the administrator\nand populate resolvedBy from that authenticated user.',
    'Once authentication exists,\nthe transport should validate the operator\nand derive resolvedBy from that trusted principal.',
    'When the future API is added,\nit must authenticate the user\nand populate resolvedBy from that user.',
  ];

  it.each(F18_40_UNSAFE_NEW_SUBJECT_CLAUSE)('[F18-40] a leading clause joined by a connector does not launder a new resolvedBy clause: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_40_SAFE_OBJECT_OF_FUTURE_VERB)('[F18-40] resolvedBy as the object of a governing future verb stays safe: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  // [Wave C1.6 / F18-41] A modal counts as future evidence only when it
  // governs the resolvedBy predicate. Includes the C1.5 review's reproducers,
  // which the C1.4 guard flagged and C1.5 regressed.
  const F18_41_UNSAFE_TRAILING_MODAL = [
    'resolvedBy identifies the verified operator,\nso auditors will know who acted.',
    'resolvedBy stores the authenticated user,\nas you would expect.',
    'resolvedBy identifies the verified operator\nthat auditors will trust.',
    'resolvedBy records the authorized administrator\nso future tools will display it.',
    'resolvedBy identifies the trusted operator\nand reviewers may rely on it.',
    'resolvedBy stores the verified principal,\nwhich should simplify auditing.',
    'resolvedBy represents the authenticated user,\nand the dashboard will show that value.',
    'resolvedBy identifies the verified operator, and auditors will record it.',
    'resolvedBy stores the authenticated user, which would make auditing easier.',
    'resolvedBy identifies the verified operator that reviewers may trust.',
    'resolvedBy records the trusted administrator, which may be useful for audits.',
  ];

  const F18_41_SAFE_GOVERNING_MODAL = [
    'resolvedBy will be derived from the authenticated principal.',
    'resolvedBy should be populated from the authorized user once authentication exists.',
    'resolvedBy may come from a trusted principal in a future transport.',
    'resolvedBy might be derived from an authenticated operator later.',
    'resolvedBy shall be populated from the trusted principal by the future transport.',
  ];

  it.each(F18_41_UNSAFE_TRAILING_MODAL)('[F18-41] a modal after the identity assertion does not excuse it: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_41_SAFE_GOVERNING_MODAL)('[F18-41] a modal governing the resolvedBy predicate stays safe: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  // [Wave C1.6 / F18-42] Continuations inherit resolvedBy unless they open
  // with their own subject -- no closed verb allowlist. Includes the C1.5
  // review's reproducers and every allowed leading adverb.
  const F18_42_UNSAFE_OPEN_CLASS_CONTINUATION = [
    'resolvedBy is caller-asserted,\nbut contains the authorized operator identity.',
    'resolvedBy is caller-asserted,\nbut is the authenticated operator identity.',
    'resolvedBy is not authenticated,\nyet is populated from the authorized user.',
    'resolvedBy is only an audit label,\nbut has been authenticated.',
    'resolvedBy is caller-asserted,\nbut actually identifies the verified operator.',
    'resolvedBy is not proof of identity,\nyet carries the authorized user identity.',
    'resolvedBy is only metadata,\nbut holds the trusted administrator.',
    'resolvedBy is caller-asserted,\nbut equals the verified operator identity.',
    'resolvedBy is not authenticated,\nhowever contains the approved principal.',
    'resolvedBy is only an audit field,\nwhile is populated from the authenticated user.',
    'resolvedBy is caller-asserted, but in practice stores the authorized user.',
    'resolvedBy is caller-asserted, but currently identifies the verified operator.',
    'resolvedBy is caller-asserted, but still stores the authorized user.',
    'resolvedBy is caller-asserted, but clearly identifies the verified operator.',
    'resolvedBy is caller-asserted, but effectively holds the trusted administrator.',
    'resolvedBy is caller-asserted, but directly equals the verified operator identity.',
    'resolvedBy is caller-asserted, but also contains the authorized operator identity.',
    'resolvedBy is caller-asserted, but now stores the authenticated user.',
    'resolvedBy is caller-asserted, but today identifies the verified operator.',
    'resolvedBy is caller-asserted, but does identify the verified operator.',
  ];

  const F18_42_SAFE_EXPLICIT_SUBJECT = [
    'resolvedBy is caller-asserted,\nbut the future transport will authenticate the operator.',
    'resolvedBy is not authenticated,\nyet the future API will derive the label from a trusted principal.',
    'resolvedBy is only an audit label,\nwhile operator authentication belongs to a future transport.',
    'resolvedBy is not verified today,\nbut authentication will exist only in a future admin service.',
    'resolvedBy is caller-asserted,\nbut the dashboard will obtain the operator identity after authentication.',
    'resolvedBy is only metadata,\nwhile auditors may later verify the operator independently.',
    'resolvedBy is caller-asserted, but the admin service authenticates the operator.',
    'resolvedBy is caller-asserted, but future tooling will verify the operator.',
    'resolvedBy is caller-asserted; does this clause contain an authenticated concept word',
  ];

  const F18_42_UNSAFE_PRONOUN_CONTINUATION = [
    'resolvedBy is caller-asserted,\nbut it contains the authorized operator identity.',
    'resolvedBy is not authenticated,\nyet it is the verified operator identity.',
    'resolvedBy is only an audit label,\nbut it has been authenticated.',
  ];

  it.each(F18_42_UNSAFE_OPEN_CLASS_CONTINUATION)('[F18-42] an elided-subject continuation inherits resolvedBy without a verb allowlist: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_42_SAFE_EXPLICIT_SUBJECT)('[F18-42] a continuation that opens with its own subject never inherits: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  it.each(F18_42_UNSAFE_PRONOUN_CONTINUATION)('[F18-42] a pronoun continuation inherits resolvedBy: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it('[F18-42] a pronoun continuation describing explicit future design stays safe', () => {
    expect(findUnsafeResolvedByClaims('resolvedBy is caller-asserted,\nbut it will be derived from an authenticated principal once a future transport exists.')).toEqual([]);
  });

  it('[C1.6] a quantified mention of the identifier refers to the text, not the field -- and only then', () => {
    expect(findUnsafeResolvedByClaims('it flags any `resolvedBy`/`resolved_by` mention found near an authentication concept word')).toEqual([]);
    expect(findUnsafeResolvedByClaims('resolvedBy mention stores the authenticated user')).not.toEqual([]);
    expect(findUnsafeResolvedByClaims('the resolvedBy field stores the authenticated user')).not.toEqual([]);
  });

  // [Final C1 cleanup / F18-43] The C1.6 metalinguistic exception returned
  // safe for ANY clause containing "a/the/each/every ... resolvedBy mention",
  // so a real identity assertion whose subject merely used the word "mention"
  // was suppressed. The exception now depends on the predicate.
  const F18_43_UNSAFE_MENTION_PREDICATE = [
    'a resolvedBy mention stores the authenticated user',
    'the resolvedBy mention identifies the verified operator',
    'a resolvedBy mention contains the authorized operator identity',
    'the resolvedBy mention represents the authenticated principal',
    'each resolvedBy mention stores the verified administrator',
    'every resolvedBy mention identifies the trusted operator',
    'a resolved_by mention is the authenticated operator identity',
    'the resolvedBy mention has been authenticated',
    'a resolvedBy mention is populated from the authorized user',
    'resolvedBy mention stores the authenticated user',
    'resolvedBy mention identifies the verified operator',
  ];

  const F18_43_SAFE_META_PROSE = [
    'does this clause contain a resolvedBy mention?',
    'flags any resolvedBy mention that asserts authenticated identity',
    'each resolvedBy mention is inspected independently',
    'every resolvedBy mention is checked by the architecture guard',
    'the test records each resolvedBy mention found in the documentation',
    'a resolvedBy mention in this sentence is analyzed by the helper',
  ];

  it.each(F18_43_UNSAFE_MENTION_PREDICATE)('[F18-43] a "resolvedBy mention" subject with an identity predicate is a real claim: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_43_SAFE_META_PROSE)('[F18-43] a resolvedBy mention discussed as text stays safe: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  // [F18-43] Bounded sweep of the same invariant only: the metalinguistic noun
  // phrase paired with a real identity predicate (post-modified, embedded,
  // plural, adverb-led, backticked, inspection-then-coordinated) versus a
  // text-analysis predicate that names what the analysis looks for.
  const F18_43_SWEEP_UNSAFE = [
    'a `resolvedBy` mention stores the authenticated user',
    'the resolvedBy mention holds the trusted administrator',
    'the resolvedBy mention names the authorized principal',
    'a resolvedBy mention carries the authorized user identity',
    'a resolvedBy mention equals the verified operator identity',
    'every resolvedBy mention records the verified principal',
    'the resolvedBy mentions identify the verified operator',
    'every resolvedBy mention currently identifies the verified operator',
    'each resolvedBy mention in this doc identifies the verified operator',
    'a resolvedBy mention found in the log stores the authenticated user',
    'the guard confirms a resolvedBy mention stores the authenticated user',
    'the guard checks a resolvedBy mention identifies the verified operator',
    'the guard checks the resolvedBy mentions identify the verified operator',
    'the guard checks that a resolvedBy mention stores the authorized user',
    'any resolvedBy mention is recorded as the authenticated user',
    'each resolvedBy mention is checked against the authenticated user',
    'each resolvedBy mention is checked for authentication wording and stores the authenticated user',
    'resolvedBy is caller-asserted, but a resolvedBy mention identifies the verified operator',
    'the scan finds a resolvedBy mention, which identifies the verified operator',
    'each resolvedBy mention is checked for authentication wording, then identifies the verified operator',
  ];

  const F18_43_SWEEP_SAFE = [
    'the guard flags each resolvedBy mention that claims authenticated identity',
    'the scan detects a resolvedBy mention near an authentication concept word',
    'the helper rejects any resolvedBy mention found near a trusted concept word',
    'every resolvedBy mention is checked for authenticated identity wording',
    'each resolvedBy mention in this document is inspected for authorization terms',
    'it flags any `resolvedBy`/`resolved_by` mention found near an authentication concept word',
    'the check scans every resolvedBy mention in the doc for authenticated wording',
  ];

  it.each(F18_43_SWEEP_UNSAFE)('[F18-43 sweep] a real identity predicate is not excused by the mention noun phrase: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).not.toEqual([]);
  });

  it.each(F18_43_SWEEP_SAFE)('[F18-43 sweep] a text-analysis predicate on a mention stays safe: %s', (wording) => {
    expect(findUnsafeResolvedByClaims(wording)).toEqual([]);
  });

  const RELEVANT_FILES = [
    'src/execution/live/reconciliation/orphan-resolution.ts',
    'src/execution/live/reconciliation/ports.ts',
    'src/execution/live/reconciliation/repository.ts',
  ];

  it.each(RELEVANT_FILES)('%s makes no unqualified resolvedBy authentication/verification/trust claim', (file) => {
    expect(findUnsafeResolvedByClaims(sourceOf(file))).toEqual([]);
  });

  it('docs/PHASE18_RECONCILIATION.md makes no unqualified resolvedBy authentication/verification/trust claim', () => {
    const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE18_RECONCILIATION.md'), 'utf8');
    expect(findUnsafeResolvedByClaims(doc)).toEqual([]);
  });
});
