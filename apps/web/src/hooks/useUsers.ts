import { useState, useEffect, useCallback } from 'react';
import type { User } from '@/lib/auth-api';

export function useUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    const token = localStorage.getItem('auth_token') ?? '';
    if (!token) { setLoading(false); return; }
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setUsers(data.users ?? []);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  return { users, loading, refetch: fetchUsers };
}
