import { NavienBoilerPlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform.js';

export default (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, NavienBoilerPlatform);
};
