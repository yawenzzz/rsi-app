/** Workflow operation feedback persists when the user returns to native chat. */
import { Toast, IconWarningOutlineRegular, IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

/** One transient operation result. */
export interface WorkflowNotice { text: string; tone: 'success' | 'error'; sequence: number }

type Props = InjectFace<{
  hooks: { workflowNotice: HostObservable<WorkflowNotice | null> }
  dismissNotice(): void
}>

/**
 * Present the latest operation result in the native overlay.
 * @param props - Notice subscription and dismissal action.
 * @returns a transient toast, or null when no notice exists.
 */
export function WorkflowToast({ useWorkflowNotice, dismissNotice }: Props) {
  const notice = useWorkflowNotice(value => value)
  return notice === null ? null : <Toast key={notice.sequence} text={notice.text} onDone={dismissNotice}
    icon={notice.tone === 'error' ? <IconWarningOutlineRegular /> : <IconCheckOutlineRegular />} />
}
