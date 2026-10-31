import { Link } from 'react-router-dom';
import { Wordmark } from '../components/ui';

function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full bg-ink">
      <header className="border-b border-line px-5 py-4">
        <div className="mx-auto max-w-3xl">
          <Link to="/" aria-label="Veylo home">
            <Wordmark />
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-12">
        <h1 className="text-3xl font-semibold tracking-tight text-text">{title}</h1>
        <p className="mt-2 text-sm text-faint">Last updated {updated}</p>
        <div className="mt-10 space-y-8">{children}</div>
        <nav className="mt-16 flex gap-6 border-t border-line pt-6 text-sm text-muted">
          <Link to="/" className="transition hover:text-text">
            Home
          </Link>
          <Link to="/privacy" className="transition hover:text-text">
            Privacy Policy
          </Link>
          <Link to="/terms" className="transition hover:text-text">
            Terms of Service
          </Link>
        </nav>
      </main>
    </div>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-text">{heading}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

/**
 * These documents describe how this codebase actually behaves. An operator deploying Veylo
 * must review them against their own jurisdiction, hosting arrangement and retention practice
 * before publishing — they are a starting point written to match the implementation, not
 * legal advice.
 */
export function PrivacyPolicyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="4 September 2026">
      <Section heading="The short version">
        <p>
          Veylo is designed so that we hold as little about you as we can while still delivering your
          messages. You do not give us a phone number. Your message content is encrypted on your device
          before it reaches us, and we cannot read it. We can still see that a message travelled between
          two accounts, and when — that is unavoidable for any service that delivers messages.
        </p>
        <p className="font-medium text-text">
          Veylo is private, not anonymous. We do not claim perfect security or perfect anonymity, and you
          should not treat any service as if it offered them.
        </p>
      </Section>

      <Section heading="What we collect">
        <p>
          <strong className="text-text">Your account.</strong> A username, the messaging address derived
          from it, a display name, an optional bio and profile picture, and a verifier derived from your
          passphrase. We never receive your passphrase itself — your browser derives a separate
          authenticator from it, and we store only a hash of that.
        </p>
        <p>
          <strong className="text-text">Your recovery email, if you add one.</strong> It is encrypted at
          rest and never shown to other users. We use it only for password resets, address confirmation
          and security alerts.
        </p>
        <p>
          <strong className="text-text">Your messages, as ciphertext.</strong> We store the encrypted
          bytes and one copy of the message key sealed to each recipient's public key. We hold no key
          that opens any of them.
        </p>
        <p>
          <strong className="text-text">Delivery metadata.</strong> Which accounts are in a conversation,
          when messages were sent, delivered and read, and the size of attachments. This is what makes
          delivery, ordering and unread counts work.
        </p>
        <p>
          <strong className="text-text">Security records.</strong> Sign-in times, a device label derived
          from your browser's user agent, and a keyed hash of your IP address. We store the hash rather
          than the address so we can detect brute-force attempts without keeping a log of where you have
          been.
        </p>
      </Section>

      <Section heading="What we do not collect">
        <p>
          No phone number. No contact list. No address book upload. No advertising identifiers, no
          third-party analytics, and no tracking of you across other websites.
        </p>
      </Section>

      <Section heading="What encryption does and does not cover">
        <p>
          <strong className="text-text">Encrypted end to end:</strong> message text, attachment contents,
          and attachment filenames — all encrypted in your browser before upload.
        </p>
        <p>
          <strong className="text-text">Not encrypted end to end:</strong> your username, address,
          display name, bio, profile picture, group names and descriptions, emoji reactions, and all the
          delivery metadata described above. These have to be readable by our servers for the product to
          function.
        </p>
        <p>
          Encryption also cannot protect you from the people you are talking to. Anyone in a conversation
          can screenshot, copy or forward what you send.
        </p>
      </Section>

      <Section heading="Who can see your information">
        <p>
          Other users see what your privacy settings allow: who can find you in search, who can start a
          conversation, and whether your online status, last seen, profile picture and bio are visible.
          You can change all of these at any time in Settings → Privacy.
        </p>
        <p>
          Our moderators can see account records and reports. They cannot read your messages. When you
          report a message, you choose whether to attach the text from your own device — without that,
          moderators see only that a report was filed.
        </p>
      </Section>

      <Section heading="Legal requests">
        <p>
          If we receive a valid legal order, we can only produce what we actually hold: account records,
          and the delivery metadata described above. We cannot produce message content, because we cannot
          decrypt it. We will not weaken or backdoor the encryption in response to a request.
        </p>
      </Section>

      <Section heading="How long we keep things">
        <p>
          Messages stay until you or another participant deletes them. Deleting for everyone removes the
          message keys, which makes the stored ciphertext permanently unrecoverable. Sign-in records are
          kept for a rolling window for abuse detection. Expired sessions are purged.
        </p>
        <p>
          When you delete your account, your profile, recovery email, sessions and encryption keys are
          erased. Messages you already sent remain in other people's conversations — that copy belongs to
          them, and it stays unreadable to us either way.
        </p>
      </Section>

      <Section heading="Your choices">
        <p>
          You can change your display name, bio and picture, tighten every privacy setting, block anyone,
          sign out individual devices or all of them, export nothing you did not create, and delete your
          account outright from Settings → Account.
        </p>
      </Section>

      <Section heading="Children">
        <p>Veylo is not intended for people under 13, or under the minimum age in your country.</p>
      </Section>

      <Section heading="Changes and contact">
        <p>
          If this policy changes in a way that affects you, we will say so in the app before the change
          takes effect. Questions about privacy go to the address published by whoever operates this
          deployment.
        </p>
      </Section>
    </LegalShell>
  );
}

export function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="4 September 2026">
      <Section heading="Using Veylo">
        <p>
          By creating an account you agree to these terms. You must be at least 13, or the minimum age in
          your country, whichever is higher. You are responsible for what you send and for keeping your
          passphrase safe.
        </p>
      </Section>

      <Section heading="Your passphrase">
        <p className="font-medium text-text">
          Your passphrase is the key to your messages, and we do not have a copy.
        </p>
        <p>
          If you forget it and have no recovery code, we can help you back into your account through a
          verified recovery email, but your earlier messages will stay encrypted and unreadable — to you
          and to us. This is a consequence of end-to-end encryption, not a limitation we can waive.
        </p>
      </Section>

      <Section heading="What you may not do">
        <p>Do not use Veylo to:</p>
        <ul className="ml-5 list-disc space-y-1.5">
          <li>harass, threaten, stalk or intimidate anyone;</li>
          <li>share sexual content involving minors, or anything that endangers a child;</li>
          <li>distribute malware, run phishing, or attempt fraud;</li>
          <li>send bulk unsolicited messages;</li>
          <li>impersonate another person or organisation;</li>
          <li>attack the service — probe for vulnerabilities without permission, evade rate limits, or attempt to access accounts that are not yours;</li>
          <li>break the law in your jurisdiction or ours.</li>
        </ul>
      </Section>

      <Section heading="Moderation">
        <p>
          Because message content is encrypted, moderation works on reports rather than on scanning. When
          a report arrives, moderators review the account record and any excerpt the reporter chose to
          attach. We may suspend or permanently disable accounts that break these terms. Serious cases —
          particularly child safety — are treated as such.
        </p>
        <p>
          If your account is suspended you will be told why in the app. If you think a decision is wrong,
          contact the operator of this deployment.
        </p>
      </Section>

      <Section heading="What we promise, and what we do not">
        <p>
          We work to keep Veylo available and secure, but we provide it "as is". We do not guarantee
          uninterrupted service, and we do not guarantee that any system — this one included — is
          impossible to compromise.
        </p>
        <p className="font-medium text-text">
          Think carefully before sending something whose exposure would seriously harm you. Understand how
          the security model works first; the Privacy Policy sets it out honestly, including its limits.
        </p>
      </Section>

      <Section heading="Ending your account">
        <p>
          You can delete your account at any time from Settings → Account. We may end an account that
          repeatedly or severely breaks these terms. A deleted or banned username is retired and cannot be
          claimed by anyone else.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          If these terms change materially, we will tell you in the app before the change takes effect.
          Continuing to use Veylo afterwards means you accept the updated terms.
        </p>
      </Section>
    </LegalShell>
  );
}
