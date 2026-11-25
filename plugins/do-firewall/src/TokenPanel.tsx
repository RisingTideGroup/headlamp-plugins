import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

export function TokenPanel({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState('');
  const submit = () => {
    if (value.trim()) onToken(value.trim());
  };
  return (
    <Stack spacing={2} sx={{ maxWidth: 640 }}>
      <Typography>
        Sign in with your own DigitalOcean personal access token. It stays in this browser tab only
        (cleared when the tab closes) and is sent nowhere but api.digitalocean.com.
      </Typography>
      <Alert severity="info">
        Create a token at{' '}
        <Link
          href="https://cloud.digitalocean.com/account/api/tokens"
          target="_blank"
          rel="noopener noreferrer"
        >
          cloud.digitalocean.com → API → Tokens
        </Link>
        . A custom-scoped token needs <code>kubernetes:read</code>, <code>kubernetes:update</code>{' '}
        and <code>nat_gateway:read</code>. Give it a short expiry.
      </Alert>
      <Stack direction="row" spacing={1}>
        <TextField
          label="DigitalOcean token"
          type="password"
          autoComplete="off"
          size="small"
          fullWidth
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit();
          }}
        />
        <Button variant="contained" onClick={submit} disabled={!value.trim()}>
          Connect
        </Button>
      </Stack>
    </Stack>
  );
}
