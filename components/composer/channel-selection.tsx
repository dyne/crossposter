import Link from "next/link";
import { SocialLogo } from "@/components/social-logo";
import { formatConfigIssues, type ChannelTarget } from "@/lib/compose/channels";

type Props = {
  visibleTargets: ChannelTarget[]; selected: string[]; configHydrated: boolean; configLoadFailed: boolean;
  onSelectAll: () => void; onSelectNone: () => void; onToggleTarget: (id: string) => void;
};

export function ChannelSelection({
  visibleTargets, selected, configHydrated, configLoadFailed, onSelectAll, onSelectNone, onToggleTarget
}: Props) {
  return (            <div className="channel-section">
              <div className="section-line">
                <label className="field-label">Channels</label>
                <div className="channel-actions">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectAll();
                    }}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectNone();
                    }}
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="channel-grid">
                {!configHydrated ? (
                  <div className="empty-channels is-loading">
                    <strong>Loading connected socials...</strong>
                    <span>Reading local profiles from poster.config.local.json.</span>
                  </div>
                ) : configLoadFailed ? (
                  <div className="empty-channels is-warning">
                    <strong>Could not load connected socials.</strong>
                    <span>Refresh the page or check that the local server can read the config file.</span>
                  </div>
                ) : visibleTargets.length === 0 ? (
                  <div className="empty-channels">
                    <strong>No connected socials yet.</strong>
                    <span>
                      Open <Link href="/settings">Settings</Link>, add a profile, and it will appear here.
                    </span>
                  </div>
                ) : null}
                {visibleTargets.map((target) => (
                  <label
                    className={`channel ${target.ready ? "is-ready" : "is-missing"}`}
                    key={target.targetId}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(target.targetId)}
                      onChange={() => onToggleTarget(target.targetId)}
                    />
                    <span className="channel-body">
                      <span className="channel-top">
                        <span className="channel-title">
                          <SocialLogo platform={target.id} />
                          <strong>{target.label}</strong>
                        </span>
                        <span className="channel-check" />
                      </span>
                      <span className="channel-note">{target.note}</span>
                      <span
                        className={`readiness-pill ${target.ready ? "ready" : "missing"}`}
                        title={target.ready ? "Ready" : formatConfigIssues(target.issues)}
                      >
                        {target.ready ? "Ready" : formatConfigIssues(target.issues)}
                      </span>
                      <span className="active-profile">Profile: {target.profileLabel}</span>
                      <span className="field-map" aria-label={`${target.label} field usage`}>
                        {target.uses.map((field) => (
                          <span key={field}>{field}</span>
                        ))}
                      </span>
                      <span className="channel-detail">
                        Uses this {target.label} profile from Settings.
                      </span>
                      <span className="channel-detail">{target.media}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>);
}
