"use client";

import { useState } from "react";
import type { useComposerDraft } from "./use-composer-draft";

type Props = { draft: ReturnType<typeof useComposerDraft>; mediaStorageError: string };

export function DraftStatus({ draft, mediaStorageError }: Props) {
  const [copiedText, setCopiedText] = useState<string>();
  const [downloadedText, setDownloadedText] = useState<string>();
  const [copyError, setCopyError] = useState("");
  const backupError = draft.storageError || mediaStorageError;
  const needsRecovery = draft.isLocalOnly || Boolean(backupError);
  const exportText = `Title: ${draft.title}\nLink: ${draft.linkUrl}\n\n${draft.text}`;
  const keptCopy = copiedText === exportText || downloadedText === exportText;
  const status = draft.saveConflict ? "Draft conflict" : draft.isLocalOnly ? "Local only"
    : draft.isLoadingDraft ? "Loading draft…" : draft.isSavingDraft ? "Saving draft…" : "Draft saved";

  async function copyText() {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopiedText(exportText);
      setCopyError("");
    } catch {
      setCopyError("Copy is unavailable. Download your text or select it in the editor.");
    }
  }

  return <div className="draft-status" aria-label="Draft persistence">
    <div role="status" aria-live="polite" aria-atomic="true">
      <p className="draft-status-label">{status}</p>
      {draft.isLoadingDraft ? <p>You can keep editing while your draft loads. Your changes will be kept.</p> : null}
      {draft.saveError ? <p>{draft.saveError}</p> : null}
      {draft.loadError ? <p>Draft recovery incomplete: {draft.loadError}</p> : null}
      {backupError ? <p>Browser backup unavailable: {backupError}</p> : null}
      {needsRecovery ? <p>Keep a copy before reloading. Reload replaces this page with the shared draft.</p> : null}
    </div>
    {needsRecovery ? <>
      <div className="draft-recovery-actions">
        <button type="button" className="secondary compact-button" onClick={() => void copyText()}>Copy draft text</button>
        <a className="secondary compact-button" href={`data:text/plain;charset=utf-8,${encodeURIComponent(exportText)}`}
          download="crossposter-draft.txt" onClick={() => setDownloadedText(exportText)}>Download text</a>
        {keptCopy ? <button type="button" className="secondary compact-button" onClick={() => window.location.reload()}>Reload shared draft</button> : null}
      </div>
      <p role="status" aria-live="polite">{copyError || (copiedText === exportText ? "Draft text copied." : downloadedText === exportText ? "Text download requested. Keep the file before reloading." : "")}</p>
    </> : null}
  </div>;
}
