import type { ReactNode } from "react";

type Props = {
  active: boolean;
  children?: ReactNode;
};

export const Panel = ({ active, children }: Props) => (
  <section data-active={active}>
    {active ? children : null}
  </section>
);
