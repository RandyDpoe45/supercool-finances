import { Timestamp } from './Timestamp';

/**
 * Renders a payee's cooling-off state. `usable` is the server's presentation HINT
 * (`now >= coolingOffUntil`): when true the payee is ready to receive money; when false it is still
 * cooling off and the instant it becomes usable is shown in Mexico City time (edge conversion). The
 * hint only drives the UI — the server re-checks the gate authoritatively at send time.
 */
export function CoolingOffStatus({
  usable,
  coolingOffUntil,
}: {
  usable: boolean;
  coolingOffUntil: string;
}) {
  if (usable) {
    return (
      <span className="badge cooling-off cooling-off--ready" data-usable="true">
        Ready to send
      </span>
    );
  }
  return (
    <span className="cooling-off cooling-off--waiting" data-usable="false">
      Usable from <Timestamp iso={coolingOffUntil} />
    </span>
  );
}
