import { Link } from 'react-router';

/**
 * "← API keys" above a history screen. Always a link to the list, not history.back(), so it
 * also works after opening the screen straight from an address.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="self-start font-medium no-underline hover:underline">
      <span aria-hidden="true">← </span>
      {label}
    </Link>
  );
}
