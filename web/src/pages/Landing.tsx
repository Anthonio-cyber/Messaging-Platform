import { Link } from 'react-router-dom';
import { Button, Icon, Wordmark, type IconName } from '../components/ui';
import { useAuth } from '../store/auth';

const FEATURES: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'shield',
    title: 'No phone number, ever',
    body: 'Sign up with a username and a passphrase. We never ask for a phone number, and there is no contact-list upload to opt out of.',
  },
  {
    icon: 'user',
    title: 'An identity, not a number',
    body: 'You get an address like you@veylo.chat. Share that instead of a number — it is the only thing anyone needs to reach you.',
  },
  {
    icon: 'lock',
    title: 'Encrypted before it leaves you',
    body: 'Direct messages and group messages are encrypted in your browser. The server stores ciphertext it has no key for.',
  },
  {
    icon: 'inbox',
    title: 'Message requests, not open inboxes',
    body: 'A stranger cannot land in your inbox. Their first message waits in a request queue until you accept, decline, or block.',
  },
  {
    icon: 'settings',
    title: 'Privacy controls that actually apply',
    body: 'Decide who can find you, who can message you, and whether anyone sees your online status, last seen, or read receipts.',
  },
  {
    icon: 'chat',
    title: 'Every device, in step',
    body: 'Messages arrive instantly on every signed-in device, with delivery and read state that keeps up.',
  },
];

const STEPS = [
  { title: 'Claim your name', body: 'Pick a username. It becomes your address and your sign-in.' },
  { title: 'Find someone', body: 'Search a username, an address, or a display name.' },
  { title: 'Send a request', body: 'They accept, and the conversation opens. Until then, nothing lands in their inbox.' },
];

export function LandingPage() {
  const status = useAuth((s) => s.status);
  const signedIn = status === 'authenticated';

  return (
    <div className="min-h-full bg-ink">
      <header className="sticky top-0 z-30 border-b border-line/60 bg-ink/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <Link to="/" aria-label="Veylo home">
            <Wordmark />
          </Link>
          <nav className="flex items-center gap-2">
            <Link
              to="/privacy"
              className="hidden rounded-lg px-3 py-2 text-sm text-muted transition hover:text-text sm:block"
            >
              Privacy
            </Link>
            {signedIn ? (
              <Link to="/app">
                <Button size="sm">Open Veylo</Button>
              </Link>
            ) : (
              <>
                <Link to="/sign-in">
                  <Button variant="ghost" size="sm">
                    Sign in
                  </Button>
                </Link>
                <Link to="/sign-up">
                  <Button size="sm">Create account</Button>
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden px-5 pb-20 pt-16 sm:pt-24">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[900px] -translate-x-1/2 rounded-full opacity-25 blur-3xl"
            style={{
              background:
                'radial-gradient(circle at 30% 30%, rgb(47 191 155 / 0.55), transparent 60%), radial-gradient(circle at 70% 40%, rgb(139 123 247 / 0.45), transparent 60%)',
            }}
          />
          <div className="relative mx-auto max-w-3xl text-center">
            <span className="chip mx-auto mb-6">
              <Icon name="lock" className="h-3.5 w-3.5" />
              End-to-end encrypted conversations
            </span>
            <h1 className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-text sm:text-6xl">
              Message privately.
              <br />
              Stay connected.
              <br />
              <span className="text-accent">Keep your number private.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-pretty text-[17px] leading-relaxed text-muted">
              Veylo gives you a messaging identity instead of a phone number. Share
              <span className="mx-1 rounded-md bg-raised px-1.5 py-0.5 font-mono text-[15px] text-accent">
                you@veylo.chat
              </span>
              and nothing else.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to={signedIn ? '/app' : '/sign-up'} className="w-full sm:w-auto">
                <Button size="lg" fullWidth>
                  {signedIn ? 'Open Veylo' : 'Create account'}
                </Button>
              </Link>
              {!signedIn && (
                <Link to="/sign-in" className="w-full sm:w-auto">
                  <Button size="lg" variant="secondary" fullWidth>
                    Sign in
                  </Button>
                </Link>
              )}
            </div>
            <p className="mt-5 text-sm text-faint">Free to create. No phone number. No contact upload.</p>
          </div>

          <ConversationPreview />
        </section>

        {/* Features */}
        <section className="border-t border-line/60 px-5 py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="max-w-xl text-2xl font-semibold tracking-tight text-text sm:text-3xl">
              Built around the parts of messaging people actually worry about.
            </h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="pane p-5">
                  <span className="mb-4 flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Icon name={feature.icon} className="h-[18px] w-[18px]" />
                  </span>
                  <h3 className="text-[15px] font-semibold text-text">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-line/60 px-5 py-20">
          <div className="mx-auto max-w-4xl">
            <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">
              Reaching someone takes three steps.
            </h2>
            <ol className="mt-10 grid gap-6 sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full border border-accent/40 text-sm font-semibold text-accent">
                    {index + 1}
                  </span>
                  <h3 className="mt-4 text-[15px] font-semibold text-text">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* The honest bit */}
        <section className="border-t border-line/60 px-5 py-20">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">
              What Veylo does not claim
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              Veylo is private, not anonymous, and no system is perfectly secure. Being specific matters
              more than sounding impressive, so here is the honest shape of it:
            </p>
            <ul className="mt-6 space-y-3">
              {[
                'Message text and attachments are encrypted on your device. Veylo cannot read them.',
                'Veylo can still see who talks to whom and when. That metadata is how any messaging service routes a message.',
                'Your profile name, username, and avatar are visible to people you allow. They are not encrypted.',
                'If you forget your passphrase and have no recovery code, your old messages stay unreadable — even to us.',
                'Anyone in a conversation can screenshot or copy what you send. Encryption does not change that.',
              ].map((line) => (
                <li key={line} className="flex gap-3 text-[15px] leading-relaxed text-muted">
                  <Icon name="check" className="mt-1 h-4 w-4 shrink-0 text-accent" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[15px] leading-relaxed text-muted">
              Read the{' '}
              <Link to="/privacy" className="link">
                Privacy Policy
              </Link>{' '}
              and{' '}
              <Link to="/terms" className="link">
                Terms of Service
              </Link>{' '}
              before you trust any service — including this one — with something that matters.
            </p>
          </div>
        </section>

        {/* Call to action */}
        <section className="border-t border-line/60 px-5 py-20">
          <div className="pane mx-auto max-w-3xl p-10 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">
              Claim your address.
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted">
              Short names go quickly. Pick yours, and start with the people who already know how to find you.
            </p>
            <Link to={signedIn ? '/app' : '/sign-up'} className="mt-7 inline-block">
              <Button size="lg">{signedIn ? 'Open Veylo' : 'Create account'}</Button>
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line/60 px-5 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 text-sm text-faint sm:flex-row">
          <Wordmark />
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link to="/privacy" className="transition hover:text-text">
              Privacy Policy
            </Link>
            <Link to="/terms" className="transition hover:text-text">
              Terms of Service
            </Link>
            <Link to="/sign-in" className="transition hover:text-text">
              Sign in
            </Link>
          </nav>
          <p>© {new Date().getFullYear()} Veylo</p>
        </div>
      </footer>
    </div>
  );
}

/** A still frame of the product, drawn in markup rather than shipped as a screenshot. */
function ConversationPreview() {
  return (
    <div className="relative mx-auto mt-16 max-w-3xl">
      <div className="pane overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet/20 text-sm font-semibold text-violet">
            MA
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text">Mira Adeyemi</p>
            <p className="truncate font-mono text-xs text-faint">mira@veylo.chat</p>
          </div>
          <span className="chip">
            <Icon name="lock" className="h-3 w-3 text-accent" />
            Encrypted
          </span>
        </div>
        <div className="space-y-3 px-4 py-6">
          <div className="flex justify-start">
            <div className="bubble bubble-theirs">Found you through your address. No number needed?</div>
          </div>
          <div className="flex justify-end">
            <div className="bubble bubble-mine">
              None. That was the whole idea.
              <span className="ml-2 inline-flex translate-y-px items-center gap-0.5 text-[11px] opacity-70">
                <Icon name="doubleCheck" className="h-3 w-3" />
                Read
              </span>
            </div>
          </div>
          <div className="flex justify-start">
            <div className="bubble bubble-theirs">Perfect. Sending the contact sheet tomorrow.</div>
          </div>
          <div className="flex items-center gap-2 pt-1 text-xs text-faint">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-faint" />
              <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-faint [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce2 rounded-full bg-faint [animation-delay:300ms]" />
            </span>
            Mira is typing
          </div>
        </div>
      </div>
    </div>
  );
}
