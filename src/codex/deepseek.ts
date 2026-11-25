/**
 * App Server arguments for the explicitly selected DeepSeek Responses provider.
 * The launcher supplies DEEPSEEK_API_KEY only to the protected service identity.
 * Credentials are never copied into arguments or written into configuration.
 */
export function deepseekArgs(model = 'deepseek-flash'): string[] {
  if (!['deepseek-flash','deepseek-v4-pro'].includes(model)) throw new Error('Unrecognized DeepSeek model')
  const config = [
    'model_provider="deepseek"', 'model=' + JSON.stringify(model), 'model_reasoning_effort="low"',
    'model_providers.deepseek.name="DeepSeek"', 'model_providers.deepseek.base_url="https://api.deepseek.com/"',
    'model_providers.deepseek.wire_api="responses"', 'model_providers.deepseek.env_key="DEEPSEEK_API_KEY"',
    'model_providers.deepseek.requires_openai_auth=false', 'model_providers.deepseek.supports_websockets=false',
    'model_providers.deepseek.request_max_retries=0', 'model_providers.deepseek.stream_max_retries=0',
    'analytics.enabled=false', 'web_search="disabled"', 'shell_environment_policy.inherit="none"',
  ]
  return ['app-server','--stdio', ...config.flatMap(c => ['-c', c])]
}
