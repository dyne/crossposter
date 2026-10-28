import { Send, Clock3, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { PublishedPost, PublishResult } from "@/lib/types";
import { PublishResults } from "./publish-results";
import { PublishedHistory } from "./published-history";

type Props = {
  publishedPosts: PublishedPost[]; results: PublishResult[];
  error: string; isPublishing: boolean; isUploadingMedia: boolean; onClearHistory: () => Promise<void>;
};

export function PublishPanel({
  publishedPosts, results, error, isPublishing, isUploadingMedia, onClearHistory
}: Props) {
  return (        <aside className="publish-panel" aria-labelledby="publishPanelTitle">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Publish output</p>
              <h2 id="publishPanelTitle">
                <Send size={18} />
                Published
              </h2>
            </div>
            <div className="panel-actions">
              <span className="counter">{publishedPosts.length}</span>
              {publishedPosts.length > 0 ? (
                <button
                  className="secondary compact-button"
                  type="button"
                  onClick={() => void onClearHistory()}
                >
                  Clear history
                </button>
              ) : null}
            </div>
          </div>

          <div className="publish-feed">
            {isPublishing || isUploadingMedia ? (
              <div className="publish-state is-working">
                <Clock3 size={20} />
                <div>
                  <strong>{isUploadingMedia ? "Uploading media" : "Publishing post"}</strong>
                  <span>Results will appear here on the right.</span>
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="publish-state is-error">
                <AlertTriangle size={20} />
                <div>
                  <strong>Publish failed</strong>
                  <span>{error}</span>
                </div>
              </div>
            ) : null}

            {!isPublishing &&
            !isUploadingMedia &&
            !error &&
            results.length === 0 &&
            publishedPosts.length === 0 ? (
              <div className="publish-empty">
                <CheckCircle2 size={24} />
                <strong>No published post yet</strong>
                <span>After you click Publish now, saved local history appears here.</span>
              </div>
            ) : null}

            <PublishResults results={results} />
            <PublishedHistory publishedPosts={publishedPosts} />
          </div>
        </aside>);
}
