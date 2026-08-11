import { For, Show, Switch, Match, createEffect, type JSX } from 'solid-js'
import type { FolderEntry } from '../../../shared/folder-browser'
import {
  createFolderBrowserController,
  type FolderBrowserDocument,
  type FolderBrowserLinkPreview
} from '../folder-browser-controller'
import { Button, Icon, Markdown } from '../ui'
import './FolderBrowserPage.css'
import { uiText } from '../i18n'

export interface FolderBrowserPageProps {
  folderPath: string
  label: string
  embedded?: boolean
  onBack(): void
}

function entryIcon(entry: FolderEntry): 'folder' | 'skill' | 'link' | 'warning' {
  if (entry.kind === 'directory') return 'folder'
  if (entry.kind === 'file') return 'skill'
  if (entry.kind === 'symlink') return 'link'
  return 'warning'
}

function unavailableLabel(entry: FolderEntry): string | undefined {
  if (entry.kind === 'symlink') return uiText('符号链接暂不支持预览', 'Symbolic link previews are not supported')
  if (entry.kind === 'other') return uiText('此文件类型暂不支持预览', 'This file type cannot be previewed')
  return undefined
}

function FolderTreeEntry(props: {
  entry: FolderEntry
  selectedPath?: string
  onSelect(entry: FolderEntry): void
}): JSX.Element {
  if (props.entry.kind === 'directory') {
    return (
      <li class="folder-browser-tree__directory">
        <details open>
          <summary title={props.entry.path}>
            <Icon name="folder" />
            <span>{props.entry.name}</span>
          </summary>
          <ul>
            <For each={props.entry.entries}>
              {(entry) => (
                <FolderTreeEntry
                  entry={entry}
                  selectedPath={props.selectedPath}
                  onSelect={props.onSelect}
                />
              )}
            </For>
          </ul>
        </details>
      </li>
    )
  }

  const disabled = () => props.entry.kind !== 'file'
  return (
    <li>
      <button
        type="button"
        class="folder-browser-tree__file"
        data-kind={props.entry.kind}
        data-testid="folder-browser-entry"
        aria-selected={props.selectedPath === props.entry.path}
        disabled={disabled()}
        title={unavailableLabel(props.entry) || props.entry.path}
        onClick={() => props.onSelect(props.entry)}
      >
        <Icon name={entryIcon(props.entry)} />
        <span>{props.entry.name}</span>
      </button>
    </li>
  )
}

function fileSizeLabel(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}

function readableText(document: FolderBrowserDocument): string {
  return document.kind === 'unsupported' ? '' : document.text
}

function LinkPreviewCard(props: { preview: FolderBrowserLinkPreview }) {
  const readyDocument = () => props.preview.kind === 'ready'
    ? props.preview.document
    : undefined

  return (
    <aside class="folder-browser-link-preview" role="tooltip" data-testid="folder-browser-link-preview">
      <header>
        <strong>{props.preview.target}</strong>
        <span>{props.preview.kind === 'loading'
          ? uiText('正在读取', 'Reading')
          : props.preview.kind === 'error'
            ? uiText('无法预览', 'Preview unavailable')
            : uiText('只读预览', 'Read-only preview')}</span>
      </header>
      <Switch>
        <Match when={props.preview.kind === 'loading'}>
          <div class="folder-browser-link-preview__state">{uiText('正在读取链接目标…', 'Reading link target…')}</div>
        </Match>
        <Match when={props.preview.kind === 'error'}>
          <div class="folder-browser-link-preview__state folder-browser-link-preview__state--error">
            <Icon name="warning" />
            <span>{props.preview.kind === 'error' ? props.preview.message : ''}</span>
          </div>
        </Match>
        <Match when={readyDocument()}>
          {(document) => (
            <>
              <div class="folder-browser-link-preview__path" title={document().path}>{document().path}</div>
              <Switch>
                <Match when={document().kind === 'markdown'}>
                  <Markdown
                    class="folder-browser-link-preview__markdown"
                    text={readableText(document())}
                    allowImages={false}
                  />
                </Match>
                <Match when={document().kind === 'text'}>
                  <pre class="folder-browser-link-preview__text">{readableText(document())}</pre>
                </Match>
                <Match when={document().kind === 'unsupported'}>
                  <div class="folder-browser-link-preview__state folder-browser-link-preview__state--unsupported">
                    <Icon name="warning" />
                    <span>{uiText('目标文件无法按严格 UTF-8 文本解码。', 'The target file cannot be decoded as strict UTF-8 text.')}</span>
                  </div>
                </Match>
              </Switch>
            </>
          )}
        </Match>
      </Switch>
    </aside>
  )
}

export function FolderBrowserPage(props: FolderBrowserPageProps) {
  const controller = createFolderBrowserController()

  createEffect(() => {
    void controller.load(props.folderPath)
  })

  return (
    <div class={`folder-browser-page${props.embedded ? ' folder-browser-page--embedded' : ''}`} data-testid="folder-browser-page">
      <header class={props.embedded ? 'folder-browser-page__embedded-header' : 'page-header'}>
        <div class="folder-browser-page__heading">
          <Button
            variant="ghost"
            icon="back"
            data-testid="folder-browser-close"
            onClick={props.onBack}
          >{props.embedded ? uiText('返回概览', 'Back to Overview') : uiText('返回', 'Back')}</Button>
          <div>
            <h1>{props.label}</h1>
            <div class="page-summary">
              <span>{uiText('文件浏览', 'File Browser')}</span>
              <span class="page-summary__separator">·</span>
              <span class="folder-browser-page__path" title={props.folderPath}>{props.folderPath}</span>
            </div>
          </div>
        </div>
      </header>

      <Show when={controller.error()}>
        {(message) => (
          <div class="page-error" role="alert"><Icon name="warning" />{message()}</div>
        )}
      </Show>

      <section class="folder-browser" aria-label={`${props.label} ${uiText('文件', 'files')}`}>
        <aside class="folder-browser__tree">
          <header>
            <strong>{uiText('文件', 'Files')}</strong>
            <Show when={controller.snapshot()}>
              {(snapshot) => <span>{snapshot().entries.length}</span>}
            </Show>
          </header>
          <div class="folder-browser__tree-scroll">
            <Show
              when={controller.snapshot()}
              fallback={(
                <div class="folder-browser__empty">
                  {controller.loadingFolder() ? uiText('正在读取文件夹…', 'Reading folder…') : uiText('无法读取文件夹。', 'Unable to read folder.')}
                </div>
              )}
            >
              {(snapshot) => (
                <Show
                  when={snapshot().entries.length > 0}
                  fallback={<div class="folder-browser__empty">{uiText('文件夹为空。', 'The folder is empty.')}</div>}
                >
                  <ul class="folder-browser-tree" data-testid="folder-browser-tree">
                    <For each={snapshot().entries}>
                      {(entry) => (
                        <FolderTreeEntry
                          entry={entry}
                          selectedPath={controller.selectedPath()}
                          onSelect={(selected) => void controller.selectEntry(selected)}
                        />
                      )}
                    </For>
                  </ul>
                </Show>
              )}
            </Show>
          </div>
        </aside>

        <section class="folder-browser__viewer" aria-label={uiText('文件预览', 'File preview')}>
          <nav class="folder-browser__navigation" aria-label={uiText('文件浏览历史', 'File navigation history')}>
            <div>
              <Button
                variant="ghost"
                icon="back"
                data-testid="folder-browser-history-back"
                disabled={!controller.canGoBack() || controller.loadingFile()}
                onClick={() => void controller.goBack()}
              >{uiText('后退', 'Back')}</Button>
              <Button
                variant="ghost"
                icon="forward"
                data-testid="folder-browser-history-forward"
                disabled={!controller.canGoForward() || controller.loadingFile()}
                onClick={() => void controller.goForward()}
              >{uiText('前进', 'Forward')}</Button>
            </div>
            <span title={controller.selectedPath()}>{controller.selectedPath() || uiText('未选择文件', 'No file selected')}</span>
          </nav>

          <div class="folder-browser__document">
            <Show
              when={!controller.loadingFile() && controller.document()}
              fallback={(
                <div class="folder-browser__empty folder-browser__empty--viewer">
                  {controller.loadingFile() ? uiText('正在读取文件…', 'Reading file…') : uiText('选择一个文件以预览。', 'Select a file to preview.')}
                </div>
              )}
            >
              <Show when={controller.document()}>
                {(document) => (
                  <>
                    <div class="folder-browser__document-meta">
                      <span>{document().kind === 'markdown' ? 'Markdown' : document().kind === 'text' ? uiText('纯文本', 'Plain Text') : uiText('暂不支持', 'Unsupported')}</span>
                      <span>{fileSizeLabel(document().size)}</span>
                    </div>
                    <Switch>
                      <Match when={document().kind === 'markdown'}>
                        <Markdown
                          class="folder-browser__markdown"
                          testId="folder-browser-markdown"
                          text={readableText(document())}
                          allowImages={false}
                          onOpenFile={(target) => void controller.openTarget(target)}
                          onPreviewFile={(target) => void controller.previewTarget(target)}
                        />
                      </Match>
                      <Match when={document().kind === 'text'}>
                        <pre class="folder-browser__text" data-testid="folder-browser-text">{readableText(document())}</pre>
                      </Match>
                      <Match when={document().kind === 'unsupported'}>
                        <div class="folder-browser__unsupported" data-testid="folder-browser-unsupported">
                          <Icon name="warning" />
                          <strong>{uiText('暂不支持预览', 'Preview Not Supported')}</strong>
                          <p>{uiText('这个文件无法按严格 UTF-8 文本解码。', 'This file cannot be decoded as strict UTF-8 text.')}</p>
                        </div>
                      </Match>
                    </Switch>
                  </>
                )}
              </Show>
            </Show>
          </div>
          <Show when={controller.linkPreview()}>
            {(preview) => <LinkPreviewCard preview={preview()} />}
          </Show>
        </section>
      </section>
    </div>
  )
}
