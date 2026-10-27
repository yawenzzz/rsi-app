/** Project registration and process navigation using official DSH panel slots. */
import { useId, useState } from 'react'
import { Button, Input, Tag, IconFolderCloseRegular, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { AgentWorkspaceProps } from './contract/workspace.ts'
import type { AgentWorkspaceSummary } from '../harness/client.ts'
import css from './ProjectsPage.module.css'

const statusKeys = { ready: 'projectReady', stopped: 'projectStopped', starting: 'projectStarting', failed: 'projectFailed' } as const

/**
 * Render the project-panel navigation icon.
 * @param props - Native sidebar icon geometry.
 * @returns a folder glyph.
 */
export function ProjectsIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconFolderCloseRegular size={size} /> }

type ProjectRowProps = Pick<AgentWorkspaceProps, 't' | 'openProject' | 'reviewProject' | 'onNotice'> & {
  project: AgentWorkspaceSummary
  busy: boolean
}

function ProjectRow({ project, busy, t, openProject, reviewProject, onNotice }: ProjectRowProps) {
  const open = async () => {
    try { await openProject(project.id) }
    catch (error) { onNotice(error instanceof Error ? error.message : String(error), 'error') }
  }
  return <li className={css.project}>
    <div className={css.projectMain}><div className={css.projectTitle}><IconFolderCloseRegular size={18} />
      <h2>{project.name}</h2><Tag tone={project.status === 'ready' ? 'success' : 'neutral'}>{t(statusKeys[project.status])}</Tag>
    </div><p className={css.path}>{project.path}</p>
    {project.error !== null && <p className={css.failure} role="alert">{project.error}</p>}</div>
    <div className={css.actions}>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { reviewProject(project.id) }}>{t('projectReview')}</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void open() }}>{t('projectOpen')}</Button>
    </div>
  </li>
}

/**
 * List registered projects and create a new project without modifying native workspace services.
 * @param props - Project operations, catalog and localized text.
 * @returns independent project navigation and a registration form.
 */
export function ProjectsPage(props: AgentWorkspaceProps) {
  const { t } = props
  const feed = props.useWorkspaceCatalog(value => value)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = useId()
  const submit = async () => {
    if (!name.trim() || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path.trim())) { setError(t('projectRequired')); return }
    setCreating(true); setError(null)
    try { await props.createProject({ name: name.trim(), path: path.trim() }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setCreating(false) }
  }
  return <section className={css.page} data-rsi-page="projects">
    <header className={css.heading}><div><h1>{t('projectTitle')}</h1><p>{t('projectIntro')}</p></div>
      <Button variant="ghost" size="sm" disabled={feed.loading || feed.busy} onClick={() => { void props.refreshWorkspaces() }}>{t('projectRefresh')}</Button>
    </header>
    {feed.error !== null && <div className={css.notice} role="alert"><span>{feed.error}</span>
      <Button variant="ghost" size="sm" onClick={() => { void props.refreshWorkspaces() }}>{t('retry')}</Button></div>}
    {feed.loading && feed.status === null ? <div className={css.empty} role="status" aria-label={t('loading')}>
      <IconLoadingOutlineRegular size={22} className={css.spinner} /></div>
      : <><p className={css.count}>{t('projectCount', { count: feed.status?.workspaces.length ?? 0 })}</p>
        {feed.status?.workspaces.length ? <ul className={css.projects}>{feed.status.workspaces.map(project =>
          <ProjectRow key={project.id} project={project} busy={feed.busy || creating} t={t}
            openProject={props.openProject} reviewProject={props.reviewProject} onNotice={props.onNotice} />)}</ul>
          : <div className={css.empty}><IconFolderCloseRegular size={28} /><h2>{t('projectEmpty')}</h2><p>{t('projectEmptyHint')}</p></div>}
      </>}
    <form className={css.form} aria-labelledby={`${formId}-title`} onSubmit={event => { event.preventDefault(); void submit() }}>
      <h2 id={`${formId}-title`}>{t('projectCreate')}</h2>
      <div className={css.fields}>
        <label htmlFor={`${formId}-name`}><span>{t('projectName')}</span><Input id={`${formId}-name`} value={name}
          placeholder={t('projectNamePlaceholder')} maxLength={128} disabled={creating || feed.busy}
          onChange={event => { setName(event.target.value) }} /></label>
        <label htmlFor={`${formId}-path`}><span>{t('projectPath')}</span><Input id={`${formId}-path`} value={path}
          placeholder={t('projectPathPlaceholder')} disabled={creating || feed.busy}
          onChange={event => { setPath(event.target.value) }} /></label>
      </div>
      {error !== null && <p className={css.failure} role="alert">{error}</p>}
      <div className={css.actions}><Button type="submit" disabled={creating || feed.busy}>{t('projectCreateOpen')}</Button></div>
    </form>
  </section>
}
