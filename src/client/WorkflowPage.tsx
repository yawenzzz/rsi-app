/** Workflow for the project selected through RSI-owned navigation. */
import { Button, IconFolderCloseRegular, IconListPenOutlineRegular, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { AgentWorkspaceProps } from './contract/workspace.ts'
import { CognitionPanel } from './CognitionPanel.tsx'
import css from './WorkflowPage.module.css'

/**
 * Render the workflow entry using the native sidebar's requested icon size.
 * @param props - Sidebar presentation inputs.
 * @returns the task-list glyph.
 */
export function WorkflowIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconListPenOutlineRegular size={size} />
}

/**
 * Review the selected project's tasks while keeping its conversation independent.
 * @param props - Current-project commands and authoritative catalog.
 * @returns Project identity and its isolated workflow records.
 */
export function WorkflowPage(props: AgentWorkspaceProps) {
  const { t } = props
  const feed = props.useWorkspaceCatalog(value => value)
  const directory = props.useAgentDirectory(value => value)
  const project = feed.status?.workspaces.find(item => item.id === directory.id)
  const applyUpdates = async () => {
    try {
      if (await props.restartWorkspace()) props.onNotice(t('flowRestarted'))
    } catch (error) { props.onNotice(error instanceof Error ? error.message : String(error), 'error') }
  }
  return <section className={css.page} data-rsi-page="workflow">
    <header className={css.heading}><div><h1>{t('cogWorkflow')}</h1><p>{t('flowIntro')}</p></div>
      <Button variant="ghost" size="sm" onClick={props.showProjects}>{t('projectBack')}</Button></header>
    {project !== undefined && <div className={css.projectBar}>
      <div className={css.projectIdentity}><span className={css.label}>{t('flowProject')}</span>
        <div className={css.projectName}><IconFolderCloseRegular size={16} /><span>{project.name}</span></div>
        <span className={css.path}>{project.path}</span>
      </div>
      <Button variant="ghost" size="sm" disabled={feed.busy} onClick={() => { void applyUpdates() }}>
        {t(props.restartRequiresManager ? 'flowRestartFromManager' : 'flowRestart')}</Button>
      {props.restartRequiresManager && <p className={css.restartHint}>{t('flowRestartManagerHint')}</p>}
    </div>}
    {feed.error !== null && <div className={css.notice} role="alert"><span>{feed.error}</span>
      <Button size="sm" variant="ghost" onClick={() => { void props.refreshWorkspaces() }}>{t('retry')}</Button></div>}
    {feed.loading && feed.status === null ? <div className={css.empty} role="status" aria-label={t('loading')}>
      <IconLoadingOutlineRegular className={css.spinner} size={22} /></div>
      : project === undefined ? <div className={css.empty}><IconListPenOutlineRegular size={28} />
        <h2>{t('flowEmpty')}</h2><p>{t('flowEmptyHint')}</p>
        <Button variant="outline" onClick={props.showProjects}>{t('projectTitle')}</Button></div>
        : <CognitionPanel key={project.id} {...props} refreshToken={feed} onNotice={props.onNotice} />}
  </section>
}
