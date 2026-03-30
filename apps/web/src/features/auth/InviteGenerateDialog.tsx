import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { createInvite } from '@/lib/auth-api';

interface InviteGenerateDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function InviteGenerateDialog({ isOpen, onClose }: InviteGenerateDialogProps) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await createInvite();
      setInviteUrl(res.inviteUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate invite');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setInviteUrl(null);
    setError(null);
    setCopied(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-sm border-2 border-zinc-900 bg-white p-6 shadow-[8px_8px_0_0_rgba(0,0,0,0.3)]">
        <h2 className="mb-4 text-base font-bold text-zinc-900">Generate Invite Link</h2>

        {!inviteUrl ? (
          <>
            <p className="mb-4 text-sm text-zinc-500">
              Generate a single-use invite link (valid for 24 hours) to allow a new user to create an account.
            </p>

            {error && (
              <div className="mb-4 rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleGenerate}
                disabled={isLoading}
                className="flex-1 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] py-2 text-sm font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] transition-all hover:translate-y-[1px] hover:bg-[#f7ca2e] hover:shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] active:translate-y-[2px] active:shadow-none disabled:opacity-50"
              >
                {isLoading ? 'Generating...' : 'Generate Link'}
              </Button>
              <Button
                onClick={handleClose}
                variant="outline"
                className="rounded-sm border-2 border-zinc-900 bg-white px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-3 text-sm text-zinc-500">
              Share this link with the new user. It expires in 24 hours and can only be used once.
            </p>

            <div className="mb-4 rounded-sm border-2 border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="break-all text-xs font-mono text-zinc-700">{inviteUrl}</p>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleCopy}
                className="flex-1 rounded-sm border-2 border-zinc-900 bg-[#ffd54a] py-2 text-sm font-semibold text-zinc-900 shadow-[2px_2px_0_0_rgba(0,0,0,0.12)] transition-all hover:translate-y-[1px] hover:bg-[#f7ca2e] hover:shadow-[1px_1px_0_0_rgba(0,0,0,0.12)] active:translate-y-[2px] active:shadow-none"
              >
                {copied ? 'Copied!' : 'Copy Link'}
              </Button>
              <Button
                onClick={handleClose}
                variant="outline"
                className="rounded-sm border-2 border-zinc-900 bg-white px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
