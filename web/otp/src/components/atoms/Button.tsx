import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** Minimal styled button atom. Defaults to `type="button"` (never an accidental form
 * submit) and a `primary` visual variant; all other native button attributes pass through. */
export function Button({
  children,
  variant = 'primary',
  type = 'button',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  children: ReactNode;
}) {
  const classes = ['btn', `btn--${variant}`, className].filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
