# Azure Communication Services VoIP Testing Web App

A comprehensive React-based testing application for Azure Communication Services VoIP calling capabilities. This app provides a user-friendly interface for testing various call types including group calls, 1:1 calls, PSTN phone calls, and incoming call handling.

![Azure Communication Services](https://img.shields.io/badge/Azure-Communication%20Services-blue)
![React](https://img.shields.io/badge/React-19.1.1-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-Latest-blue)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.1.11-blue)

## Features

### Call Types Supported
- **Group Calls**: Multi-participant calls using Group IDs
- **1:1 Calls**: Direct calls between two Azure Communication Services users
- **PSTN Calls**: Phone calls to regular phone numbers (requires phone number provisioning)

### Key Features
- 🎯 **Real-time Call Management**: Handle call states (connecting, connected, disconnected)
- 📞 **Incoming Call Handling**: Listen for and accept/reject incoming calls
- 💾 **Configuration Persistence**: Save and load call configurations via localStorage
- 🔐 **Token Validation**: JWT token validation with expiration tracking
- 📱 **Responsive Design**: Modern UI built with Tailwind CSS
- 🎮 **Test Mode**: Simulate incoming calls for testing purposes
- 📊 **Call State Monitoring**: Real-time call status indicators
- 🔧 **Easy Configuration**: Form-based setup for all call parameters

## Prerequisites

Before using this application, you need:

1. **Azure Communication Services Resource**: Set up in Azure Portal
2. **User Identity**: Created through Azure Communication Services Identity SDK
3. **Access Token**: Generated for the user identity
4. **Phone Number** (for PSTN calls): Purchased and configured in Azure

## Getting Started

### Installation

```bash
# Clone the repository
git clone https://github.com/duc-hoang-161/azure-communication-voip-testing-webapp.git

# Navigate to project directory
cd azure-communication-voip-testing-webapp

# Install dependencies
npm install
# or
pnpm install
# or
yarn install
```

### Running the Application

```bash
# Start development server
npm run dev
# or
pnpm dev
# or
yarn dev
```

The application will be available at `http://localhost:5173`

### Building for Production

```bash
# Build the application
npm run build
# or
pnpm build
# or
yarn build
```

## Configuration

### Required Fields

1. **User ID**: Azure Communication Services user identifier (format: `8:acs:resource-id_user-id`)
2. **Access Token**: JWT token for authentication
3. **Display Name**: Your display name in calls
4. **Call Type**: Select from Group Call, 1:1 Call, or Phone Call (PSTN)
5. **Call Value**: Corresponding value based on call type:
   - Group Call: Group ID (UUID format)
   - 1:1 Call: Target user's Azure Communication Services ID
   - Phone Call: Phone number with country code (e.g., +1234567890)

### Optional Fields

- **Alternate Caller ID**: Required for PSTN calls - your registered phone number

### Configuration Management

- **Save Configuration**: Store settings in browser localStorage
- **Load Configuration**: Restore previously saved settings
- **Clear All**: Reset all configuration fields

## Usage Guide

### Making Outbound Calls

1. Fill in the required configuration fields
2. Select your desired call type
3. Enter the appropriate call value (Group ID, User ID, or Phone Number)
4. Click "Start Call" to initiate the connection

### Handling Incoming Calls

1. Configure your User ID, Token, and Display Name
2. Click "Listen for Calls" to start monitoring for incoming calls
3. When a call comes in, you'll see a modal with Accept/Reject options
4. Use "Test Incoming Call" to simulate calls for testing

### Call Management

- **Real-time Status**: Monitor call states (None, Connecting, Connected, Disconnected)
- **Participant Updates**: See when participants join or leave calls
- **Call Controls**: Disconnect calls using the interface
- **Error Handling**: Clear error messages and troubleshooting info

## Technology Stack

- **Frontend**: React 19.1.1 with TypeScript
- **Styling**: Tailwind CSS 4.1.11
- **Icons**: Heroicons
- **Build Tool**: Vite
- **Azure SDK**: 
  - `@azure/communication-calling` - Core calling functionality
  - `@azure/communication-react` - React components for calling
  - `@azure/communication-common` - Common utilities

## Development

### Project Structure

```
src/
├── App.tsx              # Main application component
├── App.css             # Application styles
├── main.tsx            # Application entry point
├── index.css           # Global styles
└── vite-env.d.ts       # TypeScript definitions
```

### Key Components

- **Call Configuration Form**: User input for connection parameters
- **Call Interface**: Full-screen calling experience using Azure's CallComposite
- **Incoming Call Modal**: Accept/reject interface for incoming calls
- **Status Indicators**: Real-time call state and participant updates
- **Token Validator**: JWT parsing and expiration checking

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Troubleshooting

### Common Issues

1. **Token Expired**: The app validates JWT tokens and shows expiration warnings
2. **Invalid User ID**: Ensure User ID follows the correct format
3. **PSTN Call Failures**: Verify phone number provisioning in Azure
4. **Connection Issues**: Check network connectivity and Azure service status

### Token Generation

Generate access tokens using the Azure Communication Services Identity SDK:

```javascript
const { CommunicationIdentityClient } = require('@azure/communication-identity');
const client = new CommunicationIdentityClient(connectionString);
const user = await client.createUser();
const token = await client.getToken(user, ['voip']);
```

## License

This project is open source and available under the [MIT License](LICENSE).

## Related Resources

- [Azure Communication Services Documentation](https://docs.microsoft.com/en-us/azure/communication-services/)
- [React Calling SDK Documentation](https://docs.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/getting-started-with-calling)
- [PSTN Calling Setup Guide](https://docs.microsoft.com/en-us/azure/communication-services/concepts/telephony-sms/plan-solution)

## Support

For issues and questions:
- Check the [Issues](https://github.com/duc-hoang-161/azure-communication-voip-testing-webapp/issues) page
- Review Azure Communication Services documentation
- Contact the repository maintainers
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
