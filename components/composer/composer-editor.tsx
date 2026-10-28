import { formatBytes } from "@/lib/compose/presentation";

import type { LimitHint } from "@/lib/compose/validation";
type Props = {
  title: string; text: string; linkUrl: string;
  onTitleChange: (value: string) => void; onTextChange: (value: string) => void; onLinkChange: (value: string) => void;
  titleLimitWarnings: LimitHint[]; postLimitWarnings: LimitHint[];
  devtoBodyLimitWarning: LimitHint | null; isHackerNewsOnly: boolean;
};

export function ComposerEditor({
  title, text, linkUrl, onTitleChange, onTextChange, onLinkChange,
  titleLimitWarnings, postLimitWarnings, devtoBodyLimitWarning, isHackerNewsOnly
}: Props) {
  return <>
            <div className="field">
              <label className="field-label" htmlFor="title">
                Title
              </label>
              <input
                id="title"
                value={title}
                onChange={(event) => {
                  onTitleChange(event.target.value);
                }}
                placeholder="Write title here"
              />
              {titleLimitWarnings.length > 0 ? (
                <div className="limit-stack">
                  {titleLimitWarnings.map((hint) => (
                    <span
                      className={`field-hint ${hint.isWarning ? "is-warning" : ""}`}
                      key={hint.id}
                    >
                      {hint.label}: {hint.length}/{hint.limit} characters.
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="linkUrl">
                Link
              </label>
              <input
                id="linkUrl"
                inputMode="url"
                value={linkUrl}
                onChange={(event) => {
                  onLinkChange(event.target.value);
                }}
                placeholder="example.com or https://example.com"
              />
              <span className="field-hint">
                Optional. Hacker News uses this as the submitted URL.
              </span>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="text">
                Post
              </label>
              <textarea
                id="text"
                value={text}
                onChange={(event) => {
                  onTextChange(event.target.value);
                }}
                placeholder="Write the post once."
              />
              {postLimitWarnings.length > 0 || devtoBodyLimitWarning ? (
                <div className="limit-stack">
                  {postLimitWarnings.map((hint) => (
                    <span
                      className={`field-hint ${hint.isWarning ? "is-warning" : ""}`}
                      key={hint.id}
                    >
                      {hint.label}: {hint.length}/{hint.limit} characters.
                    </span>
                  ))}
                  {devtoBodyLimitWarning ? (
                    <span className="field-hint is-warning" key={devtoBodyLimitWarning.id}>
                      {devtoBodyLimitWarning.label}: {formatBytes(devtoBodyLimitWarning.length)}/
                      {formatBytes(devtoBodyLimitWarning.limit)}.
                    </span>
                  ) : null}
                </div>
              ) : null}
              {isHackerNewsOnly ? (
                <span className="field-hint">
                  For Hacker News, Post is optional. Title is required.
                </span>
              ) : null}
            </div>

</>;
}
