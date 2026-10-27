/** Locale-owned text for RSI project navigation and cognitive workflows. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { cognitionEn, cognitionZh } from './locales/cognition.ts'

/** Chinese project and workflow labels. */
export const zh = {
  ...cognitionZh,
  locale: 'zh-CN', loading: '加载中', completed: '已完成', retry: '重试',
  flowIntro: '查看当前项目的任务阶段、能力与验证结果',
  flowProject: '当前项目', flowEmpty: '请选择 RSI 项目',
  flowEmptyHint: '在项目页选择一个项目，查看它的任务、能力和评价记录',
  flowRestart: '应用能力更新', flowRestarted: '能力更新已应用',
  flowRestartFromManager: '前往主应用更新', flowRestartManagerHint: '在主应用中点击“应用能力更新”，以安全重启此 Agent',
  flowManagerMissing: '缺少主应用地址，请从主应用打开此项目后重试',
  projectTitle: 'RSI 项目', projectIntro: '每个项目使用独立的 Agent 进程、配置与对话记录',
  projectEmpty: '还没有项目', projectEmptyHint: '添加一个本地目录，开始使用这个项目的 Agent',
  projectCreate: '添加项目', projectCreateOpen: '创建并进入', projectName: '项目名称', projectPath: '项目目录',
  projectNamePlaceholder: '例如：研究助手', projectPathPlaceholder: '本地项目的绝对路径',
  projectRequired: '请填写项目名称和绝对目录路径', projectOpen: '进入对话', projectReview: '任务与评价',
  projectRefresh: '刷新', projectBack: '查看项目', projectReady: '已启动', projectStopped: '未启动',
  projectStarting: '启动中', projectFailed: '启动失败', projectCount: '{count} 个项目',
  projectCreated: '项目已创建', projectUnavailable: '项目已不在目录中，请刷新后重试',
  projectCreatedOpenFailed: '项目已创建，但启动失败：{reason}。可在项目列表中重试进入',
}
/** Translation keys shared by both dictionaries. */
export type RsiKey = keyof typeof zh
/** English project and workflow labels. */
export const en = {
  ...cognitionEn,
  locale: 'en-US', loading: 'Loading', completed: 'Completed', retry: 'Retry',
  flowIntro: 'Review the current project’s task phases, capabilities and validation results',
  flowProject: 'Current project', flowEmpty: 'Select an RSI project',
  flowEmptyHint: 'Choose a project to review its tasks, capabilities and human assessments.',
  flowRestart: 'Apply capability updates', flowRestarted: 'Capability updates applied',
  flowRestartFromManager: 'Update from manager', flowRestartManagerHint: 'Choose Apply capability updates in the manager to restart this Agent safely.',
  flowManagerMissing: 'The manager address is missing. Open this project from the manager and try again.',
  projectTitle: 'RSI projects', projectIntro: 'Each project owns its Agent process, settings and conversation history.',
  projectEmpty: 'No projects yet', projectEmptyHint: 'Add a local directory to start its project Agent.',
  projectCreate: 'Add project', projectCreateOpen: 'Create and open', projectName: 'Project name', projectPath: 'Project directory',
  projectNamePlaceholder: 'For example: Research assistant', projectPathPlaceholder: 'Absolute path to a local project directory',
  projectRequired: 'Enter a project name and an absolute directory path.', projectOpen: 'Open conversation', projectReview: 'Tasks and reviews',
  projectRefresh: 'Refresh', projectBack: 'View projects', projectReady: 'Running', projectStopped: 'Stopped',
  projectStarting: 'Starting', projectFailed: 'Startup failed', projectCount: '{count} projects',
  projectCreated: 'Project created', projectUnavailable: 'This project is no longer listed. Refresh and try again.',
  projectCreatedOpenFailed: 'The project was created, but startup failed: {reason}. Retry from the project list.',
} satisfies Record<RsiKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { rsi: RsiKey }
}
