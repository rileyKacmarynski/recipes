import type { AuthProvider } from './auth'

export const localAuthProvider: AuthProvider = async () => {
  return Promise.resolve({
    provider: 'local',
    subject: 'local@domain.com',
    email: 'local@domain.com',
  })
}
