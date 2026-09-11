/**
 * Placeholder for the analytics dashboard. The real reporting screens consume the
 * analytics server (spec 05) over its own `/analytics/admin` gateway namespace (a second
 * RTK Query slice), which is wired in a later step. No data is fetched here yet.
 */
export function AnalyticsPage() {
  return (
    <div className="home">
      <h1>Analytics</h1>
      <p>
        The analytics dashboard is pending the analytics server (spec 05). Its reporting views will
        be wired in over the <code>/analytics/admin</code> namespace in a later step.
      </p>
    </div>
  );
}
