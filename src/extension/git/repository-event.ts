/** Native open/close events define identity; API wrapper objects do not. */
export interface RepositoryEvent {
  kind: 'opened' | 'closed';
  repositoryId: string;
}
