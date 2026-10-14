import type { Api } from '../../shared/contracts';
declare global {
  interface Window {
    interviewApi?: Api;
  }
}
