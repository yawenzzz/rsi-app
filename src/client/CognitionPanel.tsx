/** Task-scoped workflow, retained evidence and explicit human evaluation. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, CodeBlock, Input, Menu, SegmentedTabs, Tag, IconChevronDownOutlineRegular, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CognitiveSnapshot, CognitiveTask, CognitiveReference, CognitivePluginSnapshot } from '../harness/client.ts'
import type { AgentWorkspaceProps } from './contract/workspace.ts'
import css from './CognitionPanel.module.css'

/** Workspace operations and optional feedback owned by the surrounding application. */
export type CognitionPanelProps = Pick<AgentWorkspaceProps,
  't' | 'readCognition' | 'readPlugins' | 'updateCognition' | 'reviewCognition' | 'captureConversation'> & {
    refreshToken: object | null
    onNotice?(text: string, tone?: 'success' | 'error'): void
  }
const phases = { clarify: 'cogClarify', 'self-evaluation': 'cogAssess', repair: 'cogRepair', execute: 'cogExecute' } as const
const phaseDescriptions = { clarify: 'cogClarifyHint', 'self-evaluation': 'cogAssessHint', repair: 'cogRepairHint', execute: 'cogExecuteHint' } as const
const phaseOrder = ['clarify', 'self-evaluation', 'repair', 'execute'] as const
const referenceKey = (unit: CognitiveReference) => `${unit.id}:${unit.revision}`
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : String(failure)

function Choice(props: {
  label: string
  value: string
  placeholder: string
  disabled: boolean
  options: { id: string; label: string }[]
  onSelect(value: string): void
}) {
  const [open, setOpen] = useState(false)
  return <div className={css.field}><span>{props.label}</span><Menu portal autoFocus open={open && !props.disabled}
    className={css.menuAnchor} listClassName={css.menu}
    items={props.options.map(item => ({ ...item, label: <span className={css.option}>{item.label}</span> }))} selectedId={props.value}
    onClose={() => { setOpen(false) }} onSelect={(value) => { props.onSelect(value); setOpen(false) }}
    anchor={<Button variant="outline" className={css.choice} aria-label={props.label} aria-haspopup="menu"
      aria-expanded={open && !props.disabled} disabled={props.disabled} onClick={() => { setOpen(!open) }}>
      <span>{props.options.find(item => item.id === props.value)?.label ?? props.placeholder}</span>
      <IconChevronDownOutlineRegular size={16} />
    </Button>} /></div>
}

function Progress({ t, task }: { t: CognitionPanelProps['t']; task: CognitiveTask | undefined }) {
  return <ol className={css.phases} aria-label={t('cogWorkflow')}>
    {phaseOrder.map((phase, index) => <li key={phase} className={css.phase} aria-current={task?.phase === phase ? 'step' : undefined}>
      <span className={css.phaseNumber} aria-hidden="true">{index + 1}</span>
      <div><span className={css.phaseTitle}>{t(phases[phase])}</span><p className={css.phaseHint}>{t(phaseDescriptions[phase])}</p></div>
    </li>)}
  </ol>
}

/**
 * Display the selected task without replacing the native conversation page.
 * @param props - Workspace operations, refresh signal and localized copy.
 * @returns Task progress, capabilities, retained evidence and human review controls.
 */
export function CognitionPanel(props: CognitionPanelProps) {
  const { t } = props
  const [state, setState] = useState<CognitiveSnapshot | null>(null)
  const [plugins, setPlugins] = useState<CognitivePluginSnapshot | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const pending = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const owner = useRef(props.readCognition)
  owner.current = props.readCognition
  const commit = (value: CognitiveSnapshot) => {
    setState(current => current !== null && current.revision > value.revision ? current : value)
  }
  useEffect(() => {
    if (pending.current) return
    const request = ++generation.current
    setError(null)
    void Promise.all([props.readCognition(), props.readPlugins()]).then(([cognition, composition]) => {
      if (generation.current !== request) return
      commit(cognition); setPlugins(composition)
    }, (failure: unknown) => {
      if (generation.current === request) setError(failureMessage(failure))
    })
    return () => { generation.current++ }
  }, [props.readCognition, props.readPlugins, props.refreshToken, reload])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (operation: () => Promise<CognitiveSnapshot>, success: string) => {
    if (pending.current) return
    const source = props.readCognition
    generation.current++; pending.current = true; setBusy(true)
    try {
      const value = await operation()
      if (mounted.current && owner.current === source) commit(value)
      props.onNotice?.(success, 'success')
    } catch (failure) {
      if (props.onNotice) props.onNotice(failureMessage(failure), 'error')
      else if (mounted.current && owner.current === source) setError(failureMessage(failure))
    } finally {
      pending.current = false
      if (mounted.current && owner.current === source) { setBusy(false); setReload(value => value + 1) }
    }
  }
  const task = state?.tasks.find(item => item.id === selected) ?? state?.tasks.at(-1)
  return <section className={css.root} aria-label={t('cogWorkflow')} aria-busy={state === null && error === null}>
    {error !== null && <div className={css.notice} role="alert"><span>{error}</span>
      <Button disabled={busy} onClick={() => { setReload(value => value + 1) }}>{t('cogRetry')}</Button></div>}
    {state === null && error === null ? <div className={css.loading} role="status" aria-label={t('loading')}>
      <IconLoadingOutlineRegular className={css.spinner} size={24} /></div> : state !== null && <>
      {task === undefined ? <><Progress t={t} task={undefined} /><div className={css.empty}><h2>{t('cogNoTasks')}</h2><p>{t('cogEmpty')}</p></div></> : <>
        <div className={css.taskHeader}><Choice label={t('cogTask')} value={task.id} placeholder={t('cogTask')} disabled={busy}
          options={state.tasks.map(item => ({ id: item.id, label: item.objective }))} onSelect={setSelected} />
        <Tag tone={task.status === 'completed' ? 'success' : 'neutral'}>{t(task.status === 'completed' ? 'completed' : 'cogActive')}</Tag></div>
        <Progress t={t} task={task} />
        <TaskContent key={task.id} {...props} state={state} plugins={plugins} task={task} busy={busy} run={run} />
      </>}
    </>}
  </section>
}

type TaskContentProps = CognitionPanelProps & {
  state: CognitiveSnapshot
  plugins: CognitivePluginSnapshot | null
  task: CognitiveTask
  busy: boolean
  run: (operation: () => Promise<CognitiveSnapshot>, success: string) => Promise<void>
}

function TaskContent({ t, state, plugins, task, busy, run, updateCognition, reviewCognition, captureConversation }: TaskContentProps) {
  const id = useId()
  const [tab, setTab] = useState<'capabilities' | 'evidence' | 'history'>('capabilities')
  const [evidenceId, setEvidenceId] = useState('')
  const [target, setTarget] = useState('')
  const [knowledge, setKnowledge] = useState('')
  const [effectiveness, setEffectiveness] = useState('')
  const [rationale, setRationale] = useState('')
  const readonly = task.status === 'completed'
  const taskEvidence = state.evidence.filter(item => item.taskId === task.id)
  const taskAssessments = state.assessments.filter(item => item.taskId === task.id)
  const taskBundles = state.plugins.filter(item => item.taskId === task.id)
  const latestExecution = taskEvidence.findLast(item => item.source === 'execution' && item.phase === 'execute')
  const acceptance = taskAssessments.findLast(item => item.target === null)
  const canComplete = latestExecution?.success === true && acceptance !== undefined && acceptance.effectiveness >= 0
    && acceptance.evidenceIds.includes(latestExecution.id)
  const evidence = taskEvidence.find(item => item.id === evidenceId)
  const unit = task.units.find(item => referenceKey(item) === target)
  const covered = evidence !== undefined && (target === 'task'
    ? task.phase === 'execute' && evidence.phase === 'execute' && evidence.source === 'execution'
    : unit !== undefined && evidence.units.some(item => referenceKey(item) === target))
  const numericKnowledge = Number(knowledge)
  const numericEffectiveness = Number(effectiveness)
  const previous = taskAssessments.findLast(item => target === 'task' ? item.target === null : item.target !== null && referenceKey(item.target) === target)
  const saved = previous !== undefined && previous.evidenceIds.length === 1 && previous.evidenceIds[0] === evidence?.id
    && previous.knowledge === (target === 'task' ? null : numericKnowledge)
    && previous.effectiveness === numericEffectiveness && previous.rationale === rationale.trim()
  const valid = !readonly && covered && rationale.trim().length > 0
    && effectiveness !== '' && Number.isFinite(numericEffectiveness) && numericEffectiveness >= -1 && numericEffectiveness <= 1
    && (target === 'task' || knowledge !== '' && Number.isFinite(numericKnowledge) && numericKnowledge >= 0 && numericKnowledge <= 1)
  const resetScores = () => { setKnowledge(''); setEffectiveness(''); setRationale('') }
  const command = (action: 'advance' | 'reassess' | 'complete') => {
    void run(() => updateCognition({ revision: state.revision, taskId: task.id, action }), t('cogTaskUpdated'))
  }
  const tabItems = [
    { value: 'capabilities', label: t('cogCapabilities'), id: `${id}-capabilities`, panelId: `${id}-capabilities-panel` },
    { value: 'evidence', label: t('cogEvidenceReview'), id: `${id}-evidence`, panelId: `${id}-evidence-panel` },
    { value: 'history', label: t('cogHistory'), id: `${id}-history`, panelId: `${id}-history-panel` },
  ] as const
  return <>
    <section className={css.summary} aria-label={t('cogTaskDetails')}>
      <h2>{task.objective}</h2><p>{task.outline}</p>
      <dl className={css.specification}><div><dt>{t('cogScope')}</dt><dd>{task.situation}</dd></div><div><dt>{t('cogCriteria')}</dt><dd>{task.criteria}</dd></div></dl>
      {!readonly && <div className={css.controls}>
        {task.phase !== 'execute' && <Button variant="primary" disabled={busy} onClick={() => { command('advance') }}>{t('cogNext')}</Button>}
        {task.phase === 'execute' && (canComplete
          ? <Button variant="primary" disabled={busy} onClick={() => { command('complete') }}>{t('cogComplete')}</Button>
          : <Button variant="primary" disabled={busy} onClick={() => { setTab('evidence') }}>{t('cogReviewResult')}</Button>)}
        {task.phase !== 'clarify' && <Button disabled={busy} onClick={() => { command('reassess') }}>{t('cogReassess')}</Button>}
      </div>}
    </section>
    <SegmentedTabs items={tabItems} value={tab} onChange={setTab} label={t('cogTaskSections')} className={css.tabs} />
    <section role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}`} className={css.tabPanel}>
      {tab === 'capabilities' && <>
        <div className={css.sectionHeader}><h3>{t('cogUnit')}</h3><span className={css.muted}>{t('cogUnitCount', { count: task.units.length })}</span></div>
        {task.units.length === 0 && <p className={css.muted}>{t('cogNoUnits')}</p>}
        <ul className={css.records}>{task.units.map((reference) => {
          const definition = state.units.find(item => referenceKey(item) === referenceKey(reference))
          const assessment = taskAssessments.findLast(item => item.target !== null && referenceKey(item.target) === referenceKey(reference))
          return <li key={referenceKey(reference)} className={css.record}>
            <div className={css.recordHeader}><h4>{definition?.capability}</h4><Tag>{t('cogRevision', { revision: reference.revision })}</Tag></div>
            <p>{definition?.content}</p>
            <dl className={css.specification}><div><dt>{t('cogApplicability')}</dt><dd>{definition?.applicability}</dd></div><div><dt>{t('cogExpected')}</dt><dd>{definition?.expectedOutcome}</dd></div></dl>
            <p className={css.muted}>{assessment === undefined ? t('cogUnassessed') : t('cogCoordinates', {
              knowledge: assessment.knowledge?.toFixed(2) ?? t('cogUnassessed'), effectiveness: assessment.effectiveness.toFixed(2) })}</p>
          </li>
        })}</ul>
        <div className={css.sectionHeader}><h3>{t('cogPlugins')}</h3></div><p className={css.muted}>{t('cogPluginWorkflow')}</p>
        {taskBundles.length === 0 ? <p className={css.muted}>{t('cogNoBundles')}</p> : <ul className={css.records}>{taskBundles.map((artifact) => {
          const status = plugins?.plugins.find(item => item.artifact.id === artifact.id)?.state
          return <li key={artifact.id} className={css.record}>
            <div className={css.recordHeader}><h4>{artifact.name}</h4><Tag>{artifact.version}</Tag></div>
            <p>{t(status === undefined ? 'cogPluginNotInstalled' : ({ selected: 'cogPluginSelected', changed: 'cogPluginChanged', disabled: 'cogPluginDisabled' } as const)[status])}</p>
            <code className={css.path}>{artifact.directory}</code>
          </li>
        })}</ul>}
        {plugins !== null && <p className={css.muted}>{t('cogProfile')}: <code className={css.path}>{plugins.profile.directory}</code></p>}
      </>}
      {tab === 'evidence' && <>
        <div className={css.sectionHeader}><h3>{t('cogRetainedEvidence')}</h3>
          {!readonly && <Button disabled={busy || task.phase === 'clarify'} onClick={() => {
            void run(() => captureConversation(task.id), t('cogCaptured'))
          }}>{t('cogCaptureConversation')}</Button>}</div>
        {taskEvidence.length === 0 ? <p className={css.muted}>{t('cogNoEvidence')}</p> : <Choice label={t('cogEvidence')}
          value={evidence?.id ?? ''} placeholder={t('cogSelectEvidence')} disabled={busy}
          options={taskEvidence.map(item => ({ id: item.id, label: `${t(phases[item.phase])} · ${new Date(item.createdAt).toLocaleString(t('locale'))} · ${item.contentHash.slice(0, 8)}` }))}
          onSelect={(value) => { setEvidenceId(value); setTarget(''); resetScores() }} />}
        {evidence !== undefined && <><p className={css.muted}>{t(evidence.source === 'execution' ? 'cogExecutionEvidence' : 'cogSubmittedEvidence')}</p>
          <div className={css.evidence}><CodeBlock code={evidence.content} copyLabel={t('cogCopy')} copiedLabel={t('cogCopied')} /></div></>}
        {readonly ? <p className={css.muted}>{t('cogCompletedReadonly')}</p> : <form className={css.review} onSubmit={(event) => {
          event.preventDefault()
          if (!valid || saved || busy) return
          const assessedUnit = target === 'task' ? null : unit
          if (assessedUnit === undefined) return
          void run(() => reviewCognition({ revision: state.revision, taskId: task.id, target: assessedUnit, evidenceIds: [evidence.id],
            knowledge: target === 'task' ? null : numericKnowledge, effectiveness: numericEffectiveness, rationale: rationale.trim() }), t('cogSaved'))
        }}>
          <h3>{t('cogReview')}</h3><p className={css.muted}>{t('cogScoreHint')}</p>
          <Choice label={t('cogTarget')} value={target} placeholder={t('cogSelectTarget')} disabled={busy || evidence === undefined}
            options={[...task.units.filter(reference => evidence?.units.some(item => referenceKey(item) === referenceKey(reference)))
              .map(reference => ({ id: referenceKey(reference),
                label: `${state.units.find(item => referenceKey(item) === referenceKey(reference))?.capability} · ${t('cogRevision', { revision: reference.revision })}` })),
            ...(task.phase === 'execute' && evidence?.phase === 'execute' && evidence.source === 'execution' ? [{ id: 'task', label: t('cogAcceptance') }] : [])]}
            onSelect={(value) => { setTarget(value); resetScores() }} />
          <div className={css.scores}>
            {target !== 'task' && <label className={css.field}>{t('cogKnowledge')}<Input type="number" min={0} max={1} step="any" required
              value={knowledge} disabled={busy || !covered} onChange={(event) => { setKnowledge(event.target.value) }} /></label>}
            <label className={css.field}>{t('cogEffectiveness')}<Input type="number" min={-1} max={1} step="any" required
              value={effectiveness} disabled={busy || !covered} onChange={(event) => { setEffectiveness(event.target.value) }} /></label>
          </div>
          <label className={css.field}>{t('cogRationale')}<textarea required value={rationale} disabled={busy || !covered} onChange={(event) => { setRationale(event.target.value) }} /></label>
          <div className={css.controls}><Button variant="primary" type="submit" disabled={busy || !valid || saved}>{t('cogSubmit')}</Button>
            {saved ? <span role="status" className={css.muted}>{t('cogSaved')}</span> : <span className={css.muted}>{t('cogRequired')}</span>}</div>
        </form>}
      </>}
      {tab === 'history' && <>
        <h3>{t('cogTransitions')}</h3>
        {taskAssessments.length === 0 ? <p className={css.muted}>{t('cogNoReviews')}</p> : <ol className={css.records}>{taskAssessments.toReversed().map((assessment) => {
          const target = assessment.target
          const definition = target === null ? undefined : state.units.find(item => referenceKey(item) === referenceKey(target))
          const transition = state.transitions.find(item => item.assessmentId === assessment.id)
          return <li key={assessment.id} className={css.record}>
            <div className={css.recordHeader}><h4>{target === null ? t('cogAcceptance') : `${definition?.capability} · ${t('cogRevision', { revision: target.revision })}`}</h4>
              <time className={css.muted} dateTime={assessment.createdAt}>{new Date(assessment.createdAt).toLocaleString(t('locale'))}</time></div>
            <p>{target === null ? t('cogTaskScore', { effectiveness: assessment.effectiveness.toFixed(2) }) : t('cogCoordinates', {
              knowledge: assessment.knowledge?.toFixed(2) ?? t('cogUnassessed'), effectiveness: assessment.effectiveness.toFixed(2) })}</p>
            <p>{assessment.rationale}</p>
            {transition !== undefined && <p className={css.muted}>{t('cogPositionChange', { from: transition.from === 'unassessed' ? t('cogUnassessed') : transition.from, to: transition.to })}</p>}
          </li>
        })}</ol>}
      </>}
    </section>
  </>
}
