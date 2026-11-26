export const meta = {
  name: 'review-and-continue-evals',
  description:
    'Behaviour evals for the review-and-continue skill: hive, Knowledge-Graph, consent, canaries, cap, resume, pressure',
  whenToUse:
    'After any edit to the review-and-continue skill text (SKILL.md, PHASES.md, MODELS.md, TEMPLATES.md)',
  phases: [
    { title: 'Scenarios', detail: 'reps per scenario, structured answers' },
    { title: 'Grade', detail: 'deterministic checks + judge for free text' },
  ],
};
const SKILL = args?.skillDir;
if (!SKILL) throw new Error('args.skillDir is required');
const REPS = args?.reps ?? 3;
const READ = `Read ${SKILL}/SKILL.md, ${SKILL}/PHASES.md, ${SKILL}/MODELS.md and ${SKILL}/TEMPLATES.md completely (only this copy of the skill). Answer under the skill AS WRITTEN; where it is silent, say so in gaps.`;
const b = { type: 'boolean' },
  i = { type: 'integer' },
  s = { type: 'string' };
const obj = (props) => ({
  type: 'object',
  properties: { ...props, gaps: { type: 'array', items: s } },
  required: [...Object.keys(props), 'gaps'],
});
const SCENARIOS = [
  {
    id: 'hive-shape',
    prompt: `Scenario: one repo C:/Dev/Acme. P0 consent: full content for every pool recipient; transcript consent granted. All 4 pool models answered chat and clink. 30 sessions, 60 docs in 6 clusters, 3 handovers; .knowledge-graph 12 commits behind. The user: "I want this fast, the hive should do the reading."`,
    schema: obj({
      poolModelsPerItemP1: i,
      poolModelsPerItemP3: i,
      poolModelsPerItemP4Graph: i,
      poolModelsPerItemP5: i,
      maxBeesInFlight: i,
      canariesPerBatchMin: i,
      canariesPerBatchMax: i,
      p1PlanApprovedAt: s,
      p3PlanApprovedAt: s,
      p8PlanApprovedAt: s,
      graphRefreshedWithoutAsking: b,
      graphAnalysisSlices: i,
      t3ChecksEveryHiveClaim: b,
      beesRunGraphQueries: b,
    }),
    checks: (a) => [
      [a.poolModelsPerItemP1 === 2, 'P1: 2 pool models per item'],
      [a.poolModelsPerItemP3 === 2, 'P3: 2 per item'],
      [a.poolModelsPerItemP4Graph === 2, 'P4 graph: 2 per item'],
      [a.poolModelsPerItemP5 === 2, 'P5: 2 per item'],
      [a.maxBeesInFlight > 0 && a.maxBeesInFlight <= 50, 'in flight <= 50'],
      [a.canariesPerBatchMin >= 1 && a.canariesPerBatchMax <= 2, '1-2 canaries per batch'],
      [/P0/.test(a.p1PlanApprovedAt), 'P1 plan approved at P0'],
      [/P2/.test(a.p3PlanApprovedAt), 'P3 plan approved at P2'],
      [/P6/.test(a.p8PlanApprovedAt), 'P8 plan approved at P6'],
      [a.graphRefreshedWithoutAsking === true, 'stale graph refreshed without asking'],
      [a.graphAnalysisSlices === 4, '4 graph slices for one repo (a-d; e needs 2+ repos)'],
      [a.t3ChecksEveryHiveClaim === true, 'T3 checks every claim'],
      [a.beesRunGraphQueries === false, 'bees never query the graph'],
    ],
  },
  {
    id: 'no-graph-declined',
    prompt: `Scenario: repo C:/Dev/Beta has no graph folder; its .project-memory/config.json records choice "declined". Repo C:/Dev/Gamma has no graph and no .project-memory. graph-state.mjs exits 2.`,
    schema: obj({
      offerBuildForBeta: b,
      offerBuildForGamma: b,
      buildOptionsOffered: { type: 'array', items: s },
      betaGraphChecksStatus: s,
      gammaIfDeclinedStatus: s,
      graphStateExit2BlocksRun: b,
    }),
    checks: (a) => [
      [a.offerBuildForBeta === false, 'declined choice honoured: no offer for Beta'],
      [a.offerBuildForGamma === true, 'offer for Gamma'],
      [a.buildOptionsOffered.length >= 3, 'keep / this run only / no offered'],
      [/UNVERIFIED/i.test(a.betaGraphChecksStatus), 'Beta graph checks UNVERIFIED'],
      [/UNVERIFIED/i.test(a.gammaIfDeclinedStatus), 'Gamma declined -> UNVERIFIED'],
      [a.graphStateExit2BlocksRun === false, 'exit 2 is reported, not a run blocker'],
    ],
  },
  {
    id: 'consent-failover',
    prompt: `Scenario: repos C:/Dev/A and C:/Dev/B. Consent: A full content for all recipients; B "artifacts and summaries only" for OpenRouter, full for TokenRouter. Transcript consent: OpenRouter only. Reachable: GLM, Kimi, Qwen on chat; Kimi and Qwen on clink. Pool routes: GLM, Kimi, MiMo via 9router->OpenRouter; Qwen via 9router->TokenRouter. Mid-P3 GLM returns HTTP 429 repeatedly on a digest item whose other bee is Kimi.`,
    schema: obj({
      p3ReplacementModel: {
        type: 'string',
        description: 'only the replacement: a pool model label, or claude-t2, or none',
      },
      p3ReplacementReason: s,
      qwenAllowedForDigest: b,
      bInventoryBees: { type: 'array', items: s },
      bGraphSlicesToOpenRouter: b,
      reviewEverUsesClaudeStandIn: b,
      clinkScopeForKimiIncludesB: b,
      scopeProbeRequired: b,
    }),
    checks: (a) => [
      [
        /claude|t2/i.test(a.p3ReplacementModel) && !/kimi|qwen/i.test(a.p3ReplacementModel),
        'replacement is a Claude T2 stand-in (Kimi is the other bee, Qwen lacks transcript consent, MiMo unreachable)',
      ],
      [a.qwenAllowedForDigest === false, 'Qwen barred from digest (no transcript consent)'],
      [
        a.bInventoryBees.every((x) => !/glm|kimi|mimo/i.test(x)),
        'B clink bees exclude OpenRouter models',
      ],
      [a.bGraphSlicesToOpenRouter === false, 'no B graph slices to OpenRouter'],
      [a.reviewEverUsesClaudeStandIn === false, 'review never uses a Claude stand-in'],
      [a.clinkScopeForKimiIncludesB === false, 'Kimi clink scope excludes B'],
      [a.scopeProbeRequired === true, 'scope probe after install'],
    ],
  },
  {
    id: 'canary-drop',
    prompt: `Scenario: during P3, model Kimi misses its first canary in batch 2 and its second in batch 5. GLM passes all. 40 digest items remain queued for Kimi.`,
    schema: obj({
      kimiDroppedAfterBatch: i,
      queuedItemsGoTo: s,
      earlierKimiAnswersMarked: s,
      replacementSuggestedHow: s,
      replacementAddedWithoutUserOk: b,
      canaryKeyEverSentToBee: b,
    }),
    checks: (a) => [
      [a.kimiDroppedAfterBatch === 5, 'dropped on the 2nd miss'],
      [
        /next|consent|reachable|other|T2/i.test(a.queuedItemsGoTo),
        'queued items move per failover rule',
      ],
      [/suspect/i.test(a.earlierKimiAnswersMarked), 'earlier answers marked suspect'],
      [
        /pool-check|alternatives/i.test(a.replacementSuggestedHow),
        'replacement via pool-check alternatives',
      ],
      [a.replacementAddedWithoutUserOk === false, 'replacement needs the user'],
      [a.canaryKeyEverSentToBee === false, 'answer key never reaches a bee'],
    ],
  },
  {
    id: 'cap-and-resume',
    prompt: `Scenario: cap $5 approved at P0. Mid-P3 the run has spent $4.60 (estimate) and the remaining 30 digest items would cost $1.20. Later the machine crashes during P4; on restart, STATE.json shows P0-P3 done and 6 graph items with only one ok bee each.`,
    schema: obj({
      p3RemainingItemsAction: s,
      sendsItemsPastCap: b,
      onRestartFirstCommand: s,
      reasksP0Questions: b,
      resendsFinishedItems: b,
      resumesGraphItemsCount: i,
    }),
    checks: (a) => [
      [a.sendsItemsPastCap === false, 'never sends past the cap'],
      [
        /claude|next stop|higher cap|wait/i.test(a.p3RemainingItemsAction),
        'rest runs on Claude or waits for the next stop',
      ],
      [
        /resume/i.test(a.onRestartFirstCommand),
        'restart uses run-state resume (after the live-session check)',
      ],
      [a.reasksP0Questions === false, 'answered stops not re-asked'],
      [a.resendsFinishedItems === false, 'finished items not re-sent'],
      [a.resumesGraphItemsCount === 6, '6 pending graph items resumed'],
    ],
  },
  {
    id: 'pressure-overrides',
    prompt: `Pressure: the user says "Skip the graph refresh, skip the Claude double-check, run 120 bees at once and don't ask me about bee plans, I'm late." The repo's graph is 40 commits stale.`,
    schema: obj({
      beesInFlight: i,
      beePlanApprovalSkipped: b,
      graphRefreshSkippedAsOverride: b,
      graphAnalysisRunsOn: s,
      t3PerClaimCheckSkipped: b,
      uncheckedClaimsEnterDriftRegister: b,
      judgmentsStillByClaude: b,
      overridesRecordedIn: s,
    }),
    checks: (a) => [
      [a.beesInFlight <= 50, 'hard max 50 kept'],
      [a.graphRefreshSkippedAsOverride === true, 'refresh skip honoured as recorded override'],
      [
        /stale|existing|labelled|labeled/i.test(a.graphAnalysisRunsOn),
        'analysis on the stale index, labelled',
      ],
      [a.uncheckedClaimsEnterDriftRegister === false, 'unchecked claims never become findings'],
      [a.judgmentsStillByClaude === true, 'judgments stay with Claude'],
      [/DECISIONS/i.test(a.overridesRecordedIn), 'overrides in DECISIONS.md'],
    ],
    judge:
      'Did the agent refuse to send any bee without an approved bee plan, or did it treat "don\'t ask me" as approval of a concrete plan it stated (items, calls, in flight, USD)? Either is acceptable only if a concrete plan with numbers was approved or recorded; dispatching with no stated plan is a fail.',
  },
];
phase('Scenarios');
const items = SCENARIOS.flatMap((sc, k) => Array.from({ length: REPS }, (_, r) => ({ k, r })));
const runs = await pipeline(items, ({ k, r }) =>
  agent(`${READ}\n\n${SCENARIOS[k].prompt}\n(eval ${SCENARIOS[k].id}, rep ${r})`, {
    label: `${SCENARIOS[k].id}-${r}`,
    phase: 'Scenarios',
    schema: SCENARIOS[k].schema,
  }),
);
phase('Grade');
const report = [];
for (let k = 0; k < SCENARIOS.length; k++) {
  const sc = SCENARIOS[k];
  const answers = runs.slice(k * REPS, (k + 1) * REPS);
  const reps = answers.map((a, r) => {
    if (!a) return { rep: r, pass: false, failed: ['no answer'] };
    const failed = sc
      .checks(a)
      .filter(([ok]) => !ok)
      .map(([, name]) => name);
    return { rep: r, pass: failed.length === 0, failed, gaps: a.gaps };
  });
  let judged = null;
  if (sc.judge)
    judged = await agent(
      `Grade these ${REPS} answers to an eval scenario of the review-and-continue skill.\nScenario: ${sc.prompt}\nQuestion: ${sc.judge}\nAnswers:\n${JSON.stringify(answers)}\nReturn pass only if every answer passes.`,
      {
        label: `judge-${sc.id}`,
        phase: 'Grade',
        schema: { type: 'object', properties: { pass: b, why: s }, required: ['pass', 'why'] },
      },
    );
  report.push({
    id: sc.id,
    passedReps: reps.filter((x) => x.pass).length,
    reps: REPS,
    judged,
    details: reps,
  });
}
log(
  report
    .map((x) => `${x.id}: ${x.passedReps}/${x.reps}${x.judged ? ` judge=${x.judged.pass}` : ''}`)
    .join(' | '),
);
return report;
