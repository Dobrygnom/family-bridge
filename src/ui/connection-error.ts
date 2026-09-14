const connectionAuthorizationPatterns = [
  /не удалось восстановить авторизацию подключения/i,
  /нет действующей авторизации подключения/i,
  /текущая авторизация не даёт доступа к сохранённой паре/i,
  /could not restore connection authori[sz]ation/i,
  /no active connection authori[sz]ation/i,
];

export function clearRecoveredConnectionError(message: string, connected: boolean) {
  if (!connected || !connectionAuthorizationPatterns.some((pattern) => pattern.test(message))) return message;
  return "";
}
