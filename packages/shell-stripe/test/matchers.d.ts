// Types for the matchers that @stripe/ui-extension-sdk/testing registers via expect.extend().
import 'vitest';

declare module 'vitest' {
  interface Assertion<T = any> {
    toContainText(text: string): T;
    toContainComponent(component: unknown, props?: Record<string, unknown>): T;
    toContainComponentTimes(component: unknown, times: number, props?: Record<string, unknown>): T;
    toHaveProps(props: Record<string, unknown>): T;
  }
}
