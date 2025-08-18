import { useState, useEffect } from 'react';
import {
    CallComposite,
    createAzureCommunicationCallAdapter,
    type CallAdapter,
    createAzureCommunicationCallAdapterFromClient,
    createStatefulCallClient,
    type StatefulCallClient,
} from '@azure/communication-react';
import {
    AzureCommunicationTokenCredential,
    type CommunicationUserIdentifier,
} from '@azure/communication-common';
import {
    PhoneIcon,
    PhoneXMarkIcon,
    BookmarkIcon,
    ArrowDownTrayIcon,
    ClockIcon,
    ExclamationTriangleIcon,
    PhoneArrowDownLeftIcon,
    BellIcon,
} from '@heroicons/react/24/outline';
import {
    type CallAgent,
    type Call,
    type IncomingCall,
    IncomingCallKind,
} from '@azure/communication-calling';

// Types for our configuration
interface CallConfig {
    userId: string;
    token: string;
    displayName: string;
    callType: 'group' | 'oneToOne' | 'phone' | '';
    callValue: string;
    alternateCallerId?: string;
}

interface TokenInfo {
    isValid: boolean;
    expirationTime?: Date;
    isExpired?: boolean;
    timeUntilExpiry?: string;
    error?: string;
}

// Function to decode JWT token
const decodeJWT = (token: string): TokenInfo => {
    try {
        if (!token || !token.includes('.')) {
            return { isValid: false, error: 'Invalid token format' };
        }

        const parts = token.split('.');
        if (parts.length !== 3) {
            return { isValid: false, error: 'Invalid JWT structure' };
        }

        // Decode the payload (second part)
        const payload = JSON.parse(atob(parts[1]));

        if (!payload.exp) {
            return {
                isValid: false,
                error: 'No expiration time found in token',
            };
        }

        const expirationTime = new Date(payload.exp * 1000); // Convert from Unix timestamp
        const now = new Date();
        const isExpired = expirationTime <= now;

        let timeUntilExpiry = '';
        if (!isExpired) {
            const timeDiff = expirationTime.getTime() - now.getTime();
            const hours = Math.floor(timeDiff / (1000 * 60 * 60));
            const minutes = Math.floor(
                (timeDiff % (1000 * 60 * 60)) / (1000 * 60)
            );

            if (hours > 0) {
                timeUntilExpiry = `${hours}h ${minutes}m`;
            } else {
                timeUntilExpiry = `${minutes}m`;
            }
        }

        return {
            isValid: true,
            expirationTime,
            isExpired,
            timeUntilExpiry,
        };
    } catch {
        return { isValid: false, error: 'Failed to decode token' };
    }
};

// Friendly error mapper for ACS startCall/adapter errors
const explainAcsError = (err: unknown): string => {
    // Try to pull useful info out of SDK errors without using any
    const errObj = (typeof err === 'object' && err !== null
        ? (err as { message?: string; code?: string | number; subCode?: string | number; innerError?: unknown })
        : undefined) || undefined;
    const inner = (errObj?.innerError && typeof errObj.innerError === 'object')
        ? (errObj.innerError as { message?: string; code?: string | number; subCode?: string | number })
        : undefined;
    const code = errObj?.code ?? inner?.code;
    const subCode = errObj?.subCode ?? inner?.subCode;
    const base = errObj?.message || String(err);

    // Known guidance for startCall 41001
    if (String(subCode) === '41001') {
        return (
            'Start call failed (41001). Check the target and configuration: ' +
            '- For PSTN, use a valid E.164 number and an Alternate Caller ID you own in the ACS resource with telephony enabled. ' +
            '- For 1:1, use a valid ACS user ID (8:acs:...) and do not call your own ID.'
        );
    }

    if (String(code) === '401' || /401|Unauthorized/i.test(base)) {
        return 'Authorization failed. The token may be invalid or expired.';
    }

    if (/expired|token/i.test(base)) {
        return 'The access token appears to be expired or invalid.';
    }

    return base;
};

// Basic validators
const isValidAcsUserId = (id: string) => /^8:acs:.+/.test(id.trim());
const isGuid = (v: string) =>
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
        v.trim()
    );
const toE164 = (num: string): string => {
    const cleaned = num.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    return cleaned ? `+${cleaned}` : '';
};
const isLikelyE164 = (num: string) => /^\+\d{7,15}$/.test(num);

function App() {
    const [callConfig, setCallConfig] = useState<CallConfig>({
        userId: '',
        token: '',
        displayName: '',
        callType: '',
        callValue: '',
        alternateCallerId: '',
    });
    const [isConnected, setIsConnected] = useState(false);
    const [callAdapter, setCallAdapter] = useState<CallAdapter | undefined>();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string>('');
    const [saveMessage, setSaveMessage] = useState<string>('');
    const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
    const [isListening, setIsListening] = useState(false);
    const [listeningAdapter, setListeningAdapter] = useState<
        CallAdapter | undefined
    >();
    const [callClient, setCallClient] = useState<
        StatefulCallClient | undefined
    >();
    const [callAgent, setCallAgent] = useState<CallAgent | undefined>();
    const [callState, setCallState] = useState<string>('None');
    const [currentCall, setCurrentCall] = useState<Call | undefined>(undefined);

    // Helper to wire adapter events in one place
    const wireAdapterEvents = (adapter: CallAdapter) => {
        adapter.on('callEnded', () => {
            console.log('Call ended event received');
            setSaveMessage('Call ended by the other party');
            setTimeout(() => setSaveMessage(''), 5000);

            // Return to main form
            setIsConnected(false);
            setCallAdapter(undefined);
            setCurrentCall(undefined);
            setCallState('None');
        });

        adapter.on('participantsJoined', (participants) => {
            console.log('Participants joined:', participants);
            setSaveMessage(
                `${participants.joined.length} participant(s) joined the call`
            );
            setTimeout(() => setSaveMessage(''), 3000);
        });

        adapter.on('participantsLeft', (participants) => {
            console.log('Participants left:', participants);
            setSaveMessage(
                `${participants.removed.length} participant(s) left the call`
            );
            setTimeout(() => setSaveMessage(''), 3000);
        });

        // Surface adapter errors to the UI with friendly messages
        adapter.on('error', (e: unknown) => {
            console.error('Adapter error:', e);
            setError(explainAcsError(e));
        });
    };

    // Load saved configuration on component mount
    useEffect(() => {
        const savedConfig = localStorage.getItem('azure-call-config');
        if (savedConfig) {
            try {
                const parsedConfig = JSON.parse(savedConfig);

                // Handle backwards compatibility with old config format
                if (
                    parsedConfig.groupId ||
                    parsedConfig.targetCallerId ||
                    parsedConfig.phoneNumber
                ) {
                    // Convert old format to new format
                    const convertedConfig: CallConfig = {
                        userId: parsedConfig.userId || '',
                        token: parsedConfig.token || '',
                        displayName: parsedConfig.displayName || '',
                        callType: parsedConfig.groupId
                            ? 'group'
                            : parsedConfig.targetCallerId
                            ? 'oneToOne'
                            : parsedConfig.phoneNumber
                            ? 'phone'
                            : '',
                        callValue:
                            parsedConfig.groupId ||
                            parsedConfig.targetCallerId ||
                            parsedConfig.phoneNumber ||
                            '',
                        alternateCallerId: parsedConfig.alternateCallerId || '',
                    };
                    setCallConfig(convertedConfig);
                    // Save the converted config in new format
                    localStorage.setItem(
                        'azure-call-config',
                        JSON.stringify(convertedConfig)
                    );
                } else {
                    // New format - validate required fields exist
                    const validConfig: CallConfig = {
                        userId: parsedConfig.userId || '',
                        token: parsedConfig.token || '',
                        displayName: parsedConfig.displayName || '',
                        callType: parsedConfig.callType || '',
                        callValue: parsedConfig.callValue || '',
                        alternateCallerId: parsedConfig.alternateCallerId || '',
                    };
                    setCallConfig(validConfig);
                }
            } catch (error) {
                console.error('Failed to load saved configuration:', error);
                setSaveMessage(
                    'Failed to load saved configuration - using defaults'
                );
                setTimeout(() => setSaveMessage(''), 3000);
            }
        }
    }, []);

    // Cleanup call agent and call client on component unmount
    useEffect(() => {
        return () => {
            // Cleanup when component unmounts
            if (callAgent) {
                try {
                    callAgent.dispose();
                } catch (error) {
                    console.error(
                        'Error disposing call agent on unmount:',
                        error
                    );
                }
            }
            if (callAdapter) {
                try {
                    callAdapter.dispose();
                } catch (error) {
                    console.error(
                        'Error disposing call adapter on unmount:',
                        error
                    );
                }
            }
            if (listeningAdapter) {
                try {
                    listeningAdapter.dispose();
                } catch (error) {
                    console.error(
                        'Error disposing listening adapter on unmount:',
                        error
                    );
                }
            }
        };
    }, [callAgent, callAdapter, listeningAdapter, currentCall]);

    // Save configuration to localStorage
    const saveConfiguration = () => {
        try {
            // Validate that we have some configuration to save
            if (
                !callConfig.userId &&
                !callConfig.token &&
                !callConfig.displayName &&
                !callConfig.callType
            ) {
                setSaveMessage(
                    'No configuration to save - please fill in some fields first'
                );
                setTimeout(() => setSaveMessage(''), 3000);
                return;
            }

            localStorage.setItem(
                'azure-call-config',
                JSON.stringify(callConfig)
            );
            setSaveMessage('Configuration saved successfully!');
            setTimeout(() => setSaveMessage(''), 3000);
        } catch (error) {
            setSaveMessage('Failed to save configuration - storage error');
            setTimeout(() => setSaveMessage(''), 3000);
            console.error('Save configuration error:', error);
        }
    };

    // Load configuration from localStorage
    const loadConfiguration = () => {
        const savedConfig = localStorage.getItem('azure-call-config');
        if (savedConfig) {
            try {
                const parsedConfig = JSON.parse(savedConfig);

                // Handle backwards compatibility with old config format
                if (
                    parsedConfig.groupId ||
                    parsedConfig.targetCallerId ||
                    parsedConfig.phoneNumber
                ) {
                    // Convert old format to new format
                    const convertedConfig: CallConfig = {
                        userId: parsedConfig.userId || '',
                        token: parsedConfig.token || '',
                        displayName: parsedConfig.displayName || '',
                        callType: parsedConfig.groupId
                            ? 'group'
                            : parsedConfig.targetCallerId
                            ? 'oneToOne'
                            : parsedConfig.phoneNumber
                            ? 'phone'
                            : '',
                        callValue:
                            parsedConfig.groupId ||
                            parsedConfig.targetCallerId ||
                            parsedConfig.phoneNumber ||
                            '',
                        alternateCallerId: parsedConfig.alternateCallerId || '',
                    };
                    setCallConfig(convertedConfig);
                    // Save the converted config in new format
                    localStorage.setItem(
                        'azure-call-config',
                        JSON.stringify(convertedConfig)
                    );
                    setSaveMessage(
                        'Configuration loaded and updated to new format!'
                    );
                } else {
                    // New format - validate required fields exist
                    const validConfig: CallConfig = {
                        userId: parsedConfig.userId || '',
                        token: parsedConfig.token || '',
                        displayName: parsedConfig.displayName || '',
                        callType: parsedConfig.callType || '',
                        callValue: parsedConfig.callValue || '',
                        alternateCallerId: parsedConfig.alternateCallerId || '',
                    };
                    setCallConfig(validConfig);
                    setSaveMessage('Configuration loaded successfully!');
                }
                setTimeout(() => setSaveMessage(''), 3000);
            } catch (error) {
                setSaveMessage('Failed to load configuration - invalid format');
                setTimeout(() => setSaveMessage(''), 3000);
                console.error('Load configuration error:', error);
            }
        } else {
            setSaveMessage('No saved configuration found');
            setTimeout(() => setSaveMessage(''), 3000);
        }
    };

    // Start listening for incoming calls (simplified approach)
    const startListeningForCalls = async () => {
        if (
            !callConfig.userId ||
            !callConfig.token ||
            !callConfig.displayName
        ) {
            setError(
                'Please fill in User ID, Token, and Display Name to listen for calls'
            );
            return;
        }

        try {
            setIsLoading(true);
            setError('');

            const credential = new AzureCommunicationTokenCredential(
                callConfig.token
            );

            // Create a stateful call client so CallComposite can attach to accepted calls later
            const newCallClient = createStatefulCallClient({
                userId: { communicationUserId: callConfig.userId },
            });
            const newCallAgent = await newCallClient.createCallAgent(
                credential,
                { displayName: callConfig.displayName }
            );

            // Store the call client and call agent in state
            setCallClient(newCallClient);
            setCallAgent(newCallAgent);

            newCallAgent.on('incomingCall', ({ incomingCall: call }) => {
                console.log('Incoming call detected:', call);
                setIncomingCall(call);
            });
            newCallAgent.on('callsUpdated', ({ added, removed }) => {
                console.log('Calls updated:', { added, removed });

                // Handle new calls being added
                added.forEach((call) => {
                    console.log(
                        'New call added:',
                        call.id,
                        'State:',
                        call.state
                    );
                    setCurrentCall(call);
                    setCallState(call.state);

                    // Listen to call state changes
                    call.on('stateChanged', () => {
                        console.log(
                            'Call state changed:',
                            call.id,
                            'New state:',
                            call.state
                        );
                        setCallState(call.state);

                        // Handle call being hung up or disconnected
                        if (call.state === 'Disconnected') {
                            console.log('Call was disconnected/hung up');
                            setSaveMessage(
                                'Call ended - the other party hung up or connection was lost'
                            );
                            setTimeout(() => setSaveMessage(''), 5000);

                            // Clean up call state
                            setCurrentCall(undefined);
                            setCallState('None');

                            // If we're in a connected call, go back to the main form
                            if (isConnected) {
                                setIsConnected(false);
                                setCallAdapter(undefined);
                            }
                        } else if (call.state === 'Connected') {
                            console.log('Call is now connected');
                            setSaveMessage('Call connected successfully');
                            setTimeout(() => setSaveMessage(''), 3000);
                        } else if (call.state === 'Connecting') {
                            console.log('Call is connecting...');
                            setSaveMessage('Connecting to call...');
                            setTimeout(() => setSaveMessage(''), 3000);
                        }
                    });
                });

                // Handle calls being removed (hung up)
                removed.forEach((call) => {
                    console.log(
                        'Call removed:',
                        call.id,
                        'Final state:',
                        call.state
                    );
                    if (currentCall && currentCall.id === call.id) {
                        setCurrentCall(undefined);
                        setCallState('None');
                        setSaveMessage('Call ended');
                        setTimeout(() => setSaveMessage(''), 3000);
                    }
                });
            });

            setIsListening(true);
            setSaveMessage(
                'Ready to receive calls. Share your User ID with callers.'
            );
            setTimeout(() => setSaveMessage(''), 5000);
        } catch (err) {
            console.error('Failed to start listening for calls:', err);
            setError(`Failed to start listening: ${err}`);
        } finally {
            setIsLoading(false);
        }
    };

    // Stop listening for incoming calls
    const stopListeningForCalls = async () => {
        try {
            // Dispose of the call agent if it exists
            if (callAgent) {
                callAgent.dispose();
                setCallAgent(undefined);
            }

            // Clear the call client
            if (callClient) {
                setCallClient(undefined);
            }

            // Clean up the listening adapter if it exists
            if (listeningAdapter) {
                listeningAdapter.dispose();
                setListeningAdapter(undefined);
            }
        } catch (error) {
            console.error('Error stopping call agent:', error);
        } finally {
            setIsListening(false);
            setIncomingCall(null);
            setCurrentCall(undefined);
            setCallState('None');
            setSaveMessage('Stopped listening for calls');
            setTimeout(() => setSaveMessage(''), 3000);
        }
    };

    // Helper to map an accepted Call to a CallAdapterLocator supported by UI lib
    const getAdapterLocatorFromCall = (call: Call) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info: any = (call as unknown as { info?: unknown }).info;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawLocator: any = (info as any)?.callLocator ?? info;
        if (!rawLocator) return undefined;
        if (rawLocator.groupId) return { groupId: rawLocator.groupId } as const;
        if (rawLocator.meetingLink)
            return { meetingLink: rawLocator.meetingLink } as const;
        if (rawLocator.roomId) return { roomId: rawLocator.roomId } as const;
        return undefined;
    };

    // Create adapter for an accepted incoming call using call locator
    const createAdapterForAcceptedCall = async (acceptedCall: Call) => {
        try {
            setIsLoading(true);
            setError('');

            const adapterLocator = getAdapterLocatorFromCall(acceptedCall);
            if (!adapterLocator) {
                throw new Error(
                    'Unsupported incoming call type. Only group/meeting/room calls are supported in this sample.'
                );
            }

            // Prefer reusing the existing client/agent if available
            if (callClient && callAgent) {
                const adapter =
                    await createAzureCommunicationCallAdapterFromClient(
                        callClient,
                        callAgent,
                        adapterLocator
                    );

                setCallAdapter(adapter);
                wireAdapterEvents(adapter);
                setIsConnected(true);
                setIsListening(false);
                setCurrentCall(acceptedCall);
                setCallState(acceptedCall.state);
                return;
            }

            // Fallback to creating fresh client/agent
            const credential = new AzureCommunicationTokenCredential(
                callConfig.token
            );
            const userId: CommunicationUserIdentifier = {
                communicationUserId: callConfig.userId,
            };

            const adapter = await createAzureCommunicationCallAdapter({
                userId,
                credential,
                displayName: callConfig.displayName,
                locator: adapterLocator,
            });

            setCallAdapter(adapter);
            wireAdapterEvents(adapter);
            setIsConnected(true);
            setIsListening(false);
            setCurrentCall(acceptedCall);
            setCallState(acceptedCall.state);
        } catch (err) {
            console.error('Failed to create adapter for accepted call:', err);
            setError(`Failed to join call: ${err}`);
        } finally {
            setIsLoading(false);
        }
    };

    // Accept incoming call
    const acceptIncomingCall = async () => {
        if (!incomingCall) return;
        try {
            setIsLoading(true);
            const call = await incomingCall.accept();
            await createAdapterForAcceptedCall(call);
            setIncomingCall(null);
        } catch (err) {
            console.error('Failed to accept incoming call:', err);
            setError(`Failed to accept call: ${err}`);
        } finally {
            setIsLoading(false);
        }
    };

    // Reject incoming call
    const rejectIncomingCall = async () => {
        await incomingCall?.reject();
        setIncomingCall(null);
        setSaveMessage('Call rejected');
        setTimeout(() => setSaveMessage(''), 3000);
    };

    // Clear saved configuration
    const clearConfiguration = () => {
        localStorage.removeItem('azure-call-config');
        setCallConfig({
            userId: '',
            token: '',
            displayName: '',
            callType: '',
            callValue: '',
            alternateCallerId: '',
        });
        setSaveMessage('Configuration cleared');
        setTimeout(() => setSaveMessage(''), 3000);
    };

    // Initialize call adapter
    const initializeCallAdapter = async () => {
        if (
            !callConfig.userId ||
            !callConfig.token ||
            !callConfig.displayName
        ) {
            setError('Please fill in all required fields');
            return;
        }

        // Prevent starting a call with an expired token
        const tokenInfo = decodeJWT(callConfig.token);
        if (tokenInfo.isValid && tokenInfo.isExpired) {
            setError('Access token is expired. Please provide a fresh token.');
            return;
        }

        if (!callConfig.callType || !callConfig.callValue) {
            setError(
                'Please select a call type and provide the corresponding value'
            );
            return;
        }

        if (callConfig.callType === 'group') {
            if (!isGuid(callConfig.callValue)) {
                setError('Invalid Group ID. Expecting a GUID.');
                return;
            }
        }

        // Additional validation per call type
        if (callConfig.callType === 'oneToOne') {
            if (callConfig.callValue.trim() === callConfig.userId.trim()) {
                setError('You cannot place a 1:1 call to yourself.');
                return;
            }
            if (!isValidAcsUserId(callConfig.callValue)) {
                setError('Invalid ACS User ID. Expected format: 8:acs:...');
                return;
            }
        }

        // Validate PSTN call requirements
        if (callConfig.callType === 'phone') {
            if (!callConfig.alternateCallerId) {
                setError(
                    'Phone Number calls require an Alternate Caller ID (your calling number)'
                );
                return;
            }
            const targetPhoneNumber = toE164(callConfig.callValue);
            const callerPhoneNumber = toE164(callConfig.alternateCallerId);
            if (!isLikelyE164(targetPhoneNumber)) {
                setError('Enter a valid E.164 phone number for the callee.');
                return;
            }
            if (!isLikelyE164(callerPhoneNumber)) {
                setError(
                    'Enter a valid E.164 Alternate Caller ID that you own in ACS.'
                );
                return;
            }
        }

        setIsLoading(true);
        setError('');

        try {
            const credential = new AzureCommunicationTokenCredential(
                callConfig.token
            );
            const userId: CommunicationUserIdentifier = {
                communicationUserId: callConfig.userId,
            };

            let adapter: CallAdapter;

            if (callConfig.callType === 'group') {
                // Group call
                adapter = await createAzureCommunicationCallAdapter({
                    userId,
                    credential,
                    displayName: callConfig.displayName,
                    locator: { groupId: callConfig.callValue },
                });
            } else if (callConfig.callType === 'oneToOne') {
                // 1:1 call
                adapter = await createAzureCommunicationCallAdapter({
                    userId,
                    credential,
                    displayName: callConfig.displayName,
                    targetCallees: [
                        { communicationUserId: callConfig.callValue.trim() },
                    ],
                });
            } else if (callConfig.callType === 'phone') {
                // Phone call - ensure phone numbers are properly formatted
                const targetPhoneNumber = toE164(callConfig.callValue);
                const callerPhoneNumber = toE164(
                    callConfig.alternateCallerId!
                );

                console.log('PSTN Call Config:', {
                    targetPhoneNumber,
                    callerPhoneNumber,
                    userId: userId.communicationUserId,
                    displayName: callConfig.displayName,
                });

                adapter = await createAzureCommunicationCallAdapter({
                    userId,
                    credential,
                    displayName: callConfig.displayName,
                    targetCallees: [{ phoneNumber: targetPhoneNumber }],
                    alternateCallerId: callerPhoneNumber,
                });
            } else {
                throw new Error('No valid call target specified');
            }

            setCallAdapter(adapter);
            wireAdapterEvents(adapter);
            setIsConnected(true);
        } catch (err) {
            console.error('Call initialization error:', err);
            setError(explainAcsError(err));
        } finally {
            setIsLoading(false);
        }
    };

    // Disconnect call
    const disconnectCall = async () => {
        try {
            if (callAdapter) {
                // First leave the call
                await callAdapter.leaveCall();
                // Then dispose of the adapter
                callAdapter.dispose();
            }
        } catch (error) {
            console.error('Error during call disconnect:', error);
        } finally {
            // Always clean up state regardless of errors
            setCallAdapter(undefined);
            setIsConnected(false);
            setIsLoading(false);
            setError('');
            setCurrentCall(undefined);
            setCallState('None');
        }
    };

    // Handle input changes
    const handleInputChange = (field: keyof CallConfig, value: string) => {
        setCallConfig((prev) => ({ ...prev, [field]: value }));
    };

    // Derived readiness of configuration (PSTN requires Alternate Caller ID)
    const isConfigReady = (() => {
        const tokenInfo = decodeJWT(callConfig.token);
        const baseReady = Boolean(
            callConfig.userId &&
                callConfig.token &&
                callConfig.displayName &&
                callConfig.callType &&
                callConfig.callValue &&
                (callConfig.callType !== 'phone' || callConfig.alternateCallerId)
        );
        if (!baseReady) return false;
        if (tokenInfo.isValid && tokenInfo.isExpired) return false;

        if (callConfig.callType === 'oneToOne') {
            return isValidAcsUserId(callConfig.callValue) &&
                callConfig.callValue.trim() !== callConfig.userId.trim();
        }
        if (callConfig.callType === 'phone') {
            return isLikelyE164(toE164(callConfig.callValue)) &&
                isLikelyE164(toE164(callConfig.alternateCallerId || ''));
        }
        if (callConfig.callType === 'group') {
            return isGuid(callConfig.callValue);
        }
        return true;
    })();

    if (isConnected && callAdapter) {
        return (
            <div className="h-screen bg-gray-500">
                <div className="h-16 bg-azure-blue-500 flex items-center justify-between px-6 shadow-lg">
                    <h1 className="text-white text-xl font-semibold">
                        Azure Communication Services Call
                    </h1>
                    <button
                        onClick={disconnectCall}
                        className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
                    >
                        <PhoneXMarkIcon className="w-5 h-5" />
                        Disconnect
                    </button>
                </div>
                <div className="h-[calc(100vh-4rem)]">
                    <CallComposite adapter={callAdapter} />
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-azure-blue-50 to-blue-100 flex items-center justify-center p-6">
            {/* Incoming Call Modal */}
            {incomingCall && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 animate-pulse">
                        <div className="text-center">
                            <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
                                <PhoneIcon className="w-10 h-10 text-white animate-bounce" />
                            </div>
                            <h2 className="text-2xl font-bold text-gray-900 mb-2">
                                Incoming Call
                            </h2>
                            <p className="text-gray-600 mb-2">
                                {incomingCall.callerInfo.displayName}
                            </p>
                            <p className="text-sm text-gray-500 mb-6">
                                {incomingCall.kind ===
                                IncomingCallKind.IncomingCall
                                    ? 'VoIP Call'
                                    : 'Teams Call'}
                            </p>

                            <div className="flex gap-4 justify-center">
                                <button
                                    onClick={rejectIncomingCall}
                                    className="flex items-center justify-center w-16 h-16 bg-red-500 hover:bg-red-600 text-white rounded-full transition-colors"
                                >
                                    <PhoneXMarkIcon className="w-8 h-8" />
                                </button>
                                <button
                                    onClick={acceptIncomingCall}
                                    className="flex items-center justify-center w-16 h-16 bg-green-500 hover:bg-green-600 text-white rounded-full transition-colors"
                                >
                                    <PhoneIcon className="w-8 h-8" />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="max-w-5xl w-full">
                <div className="bg-white rounded-2xl shadow-xl p-8">
                    {/* Header -> Compact Top Bar */}
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 bg-azure-blue-500 rounded-md flex items-center justify-center">
                                <PhoneIcon className="w-4 h-4 text-black" />
                            </div>
                            <h1 className="text-lg font-semibold text-gray-900">
                                Azure Communication Services
                            </h1>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={saveConfiguration}
                                className="inline-flex items-center gap-2 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium rounded-md transition-colors"
                            >
                                <BookmarkIcon className="w-4 h-4" />
                                Save
                            </button>
                            <button
                                type="button"
                                onClick={loadConfiguration}
                                className="inline-flex items-center gap-2 px-3 py-2 bg-green-500 hover:bg-green-600 text-white text-xs font-medium rounded-md transition-colors"
                            >
                                <ArrowDownTrayIcon className="w-4 h-4" />
                                Load
                            </button>
                            <button
                                type="button"
                                onClick={clearConfiguration}
                                className="inline-flex items-center gap-2 px-3 py-2 bg-gray-500 hover:bg-gray-600 text-white text-xs font-medium rounded-md transition-colors"
                            >
                                Clear
                            </button>
                            {!isListening ? (
                                <button
                                    type="button"
                                    onClick={startListeningForCalls}
                                    disabled={
                                        !callConfig.userId ||
                                        !callConfig.token ||
                                        !callConfig.displayName
                                    }
                                    className="inline-flex items-center gap-2 px-3 py-2 bg-purple-500 hover:bg-purple-600 disabled:bg-gray-400 text-white text-xs font-medium rounded-md transition-colors"
                                >
                                    <PhoneArrowDownLeftIcon className="w-4 h-4" />
                                    Listen
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={stopListeningForCalls}
                                    className="inline-flex items-center gap-2 px-3 py-2 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded-md transition-colors"
                                >
                                    <PhoneXMarkIcon className="w-4 h-4" />
                                    Stop
                                </button>
                            )}
                            {isListening && (
                                <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-md">
                                    <BellIcon className="w-3 h-3 animate-pulse" />
                                    Listening
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Error Message */}
                    {error && (
                        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md">
                            <p className="text-red-700 text-xs">{error}</p>
                        </div>
                    )}

                    {/* Save Message */}
                    {saveMessage && (
                        <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded-md">
                            <p className="text-green-700 text-xs">
                                {saveMessage}
                            </p>
                        </div>
                    )}

                    {/* Call State Indicator */}
                    {callState !== 'None' && currentCall && (
                        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                            <div className="flex items-center gap-2">
                                <div
                                    className={`w-2.5 h-2.5 rounded-full ${
                                        callState === 'Connected'
                                            ? 'bg-green-500 animate-pulse'
                                            : callState === 'Connecting'
                                            ? 'bg-yellow-500 animate-pulse'
                                            : callState === 'Disconnected'
                                            ? 'bg-red-500'
                                            : 'bg-gray-500'
                                    }`}
                                ></div>
                                <p className="text-blue-700 text-xs font-medium">
                                    {callState}
                                    {currentCall && (
                                        <span className="ml-2 text-blue-600">
                                            (ID: {currentCall.id?.slice(0, 8)}
                                            ...)
                                        </span>
                                    )}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Configuration Form */}
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            initializeCallAdapter();
                        }}
                        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
                    >
                        {/* User ID */}
                        <div>
                            <label
                                htmlFor="userId"
                                className="block text-xs font-medium text-gray-700 mb-1"
                            >
                                User ID (Communication User ID) *
                            </label>
                            <input
                                type="text"
                                id="userId"
                                value={callConfig.userId}
                                onChange={(e) =>
                                    handleInputChange('userId', e.target.value)
                                }
                                placeholder="8:acs:xxxx_resource_xxxx_user"
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-azure-blue-500 focus:border-azure-blue-500 transition-colors text-sm"
                                required
                            />
                        </div>

                        {/* Access Token */}
                        <div className="lg:col-span-2">
                            <label
                                htmlFor="token"
                                className="block text-xs font-medium text-gray-700 mb-1"
                            >
                                Access Token *
                            </label>
                            <textarea
                                id="token"
                                value={callConfig.token}
                                onChange={(e) =>
                                    handleInputChange('token', e.target.value)
                                }
                                placeholder="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
                                rows={2}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-azure-blue-500 focus:border-azure-blue-500 transition-colors resize-none text-sm"
                                required
                            />
                            {callConfig.token &&
                                (() => {
                                    const tokenInfo = decodeJWT(
                                        callConfig.token
                                    );
                                    if (
                                        tokenInfo.isValid &&
                                        tokenInfo.expirationTime
                                    ) {
                                        return (
                                            <div
                                                className={`mt-1 p-2 rounded-md border ${
                                                    tokenInfo.isExpired
                                                        ? 'bg-red-50 border-red-200'
                                                        : 'bg-blue-50 border-blue-200'
                                                }`}
                                            >
                                                <div className="flex items-center gap-2">
                                                    {tokenInfo.isExpired ? (
                                                        <ExclamationTriangleIcon className="w-3.5 h-3.5 text-red-500" />
                                                    ) : (
                                                        <ClockIcon className="w-3.5 h-3.5 text-blue-500" />
                                                    )}
                                                    <span
                                                        className={`text-xs font-medium ${
                                                            tokenInfo.isExpired
                                                                ? 'text-red-700'
                                                                : 'text-blue-700'
                                                        }`}
                                                    >
                                                        {tokenInfo.isExpired
                                                            ? 'Token Expired'
                                                            : 'Token Valid'}
                                                    </span>
                                                </div>
                                                <div
                                                    className={`text-[11px] mt-0.5 ${
                                                        tokenInfo.isExpired
                                                            ? 'text-red-600'
                                                            : 'text-blue-600'
                                                    }`}
                                                >
                                                    Expires:{' '}
                                                    {tokenInfo.expirationTime.toLocaleString()}
                                                    {!tokenInfo.isExpired &&
                                                        tokenInfo.timeUntilExpiry && (
                                                            <span className="ml-2">
                                                                (
                                                                {
                                                                    tokenInfo.timeUntilExpiry
                                                                }{' '}
                                                                remaining)
                                                            </span>
                                                        )}
                                                </div>
                                            </div>
                                        );
                                    } else if (tokenInfo.error) {
                                        return (
                                            <div className="mt-1 p-2 bg-yellow-50 border border-yellow-200 rounded-md">
                                                <div className="flex items-center gap-2">
                                                    <ExclamationTriangleIcon className="w-3.5 h-3.5 text-yellow-500" />
                                                    <span className="text-xs font-medium text-yellow-700">
                                                        Invalid Token
                                                    </span>
                                                </div>
                                                <div className="text-[11px] mt-0.5 text-yellow-600">
                                                    {tokenInfo.error}
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                })()}
                        </div>

                        {/* Display Name */}
                        <div>
                            <label
                                htmlFor="displayName"
                                className="block text-xs font-medium text-gray-700 mb-1"
                            >
                                Display Name *
                            </label>
                            <input
                                type="text"
                                id="displayName"
                                value={callConfig.displayName}
                                onChange={(e) =>
                                    handleInputChange(
                                        'displayName',
                                        e.target.value
                                    )
                                }
                                placeholder="Your Name"
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-azure-blue-500 focus:border-azure-blue-500 transition-colors text-sm"
                                required
                            />
                        </div>

                        {/* Call Type + Value */}
                        <div className="lg:col-span-2">
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                                Call Type *
                            </label>
                            <div className="flex flex-wrap items-center gap-6">
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        id="group-call"
                                        name="callType"
                                        type="radio"
                                        value="group"
                                        checked={
                                            callConfig.callType === 'group'
                                        }
                                        onChange={(e) => {
                                            handleInputChange(
                                                'callType',
                                                e.target.value
                                            );
                                            if (callConfig.callType !== 'group')
                                                handleInputChange(
                                                    'callValue',
                                                    ''
                                                );
                                        }}
                                        className="h-4 w-4 text-azure-blue-600 focus:ring-azure-blue-500 border-gray-300"
                                    />
                                    Group
                                </label>
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        id="one-to-one-call"
                                        name="callType"
                                        type="radio"
                                        value="oneToOne"
                                        checked={
                                            callConfig.callType === 'oneToOne'
                                        }
                                        onChange={(e) => {
                                            handleInputChange(
                                                'callType',
                                                e.target.value
                                            );
                                            if (
                                                callConfig.callType !==
                                                'oneToOne'
                                            )
                                                handleInputChange(
                                                    'callValue',
                                                    ''
                                                );
                                        }}
                                        className="h-4 w-4 text-azure-blue-600 focus:ring-azure-blue-500 border-gray-300"
                                    />
                                    1:1
                                </label>
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        id="phone-call"
                                        name="callType"
                                        type="radio"
                                        value="phone"
                                        checked={
                                            callConfig.callType === 'phone'
                                        }
                                        onChange={(e) => {
                                            handleInputChange(
                                                'callType',
                                                e.target.value
                                            );
                                            if (callConfig.callType !== 'phone')
                                                handleInputChange(
                                                    'callValue',
                                                    ''
                                                );
                                        }}
                                        className="h-4 w-4 text-azure-blue-600 focus:ring-azure-blue-500 border-gray-300"
                                    />
                                    PSTN
                                </label>
                            </div>

                            {callConfig.callType && (
                                <div className="mt-2">
                                    <label
                                        htmlFor="callValue"
                                        className="block text-xs font-medium text-gray-700 mb-1"
                                    >
                                        {callConfig.callType === 'group' &&
                                            'Group ID *'}
                                        {callConfig.callType === 'oneToOne' &&
                                            'Target User ID *'}
                                        {callConfig.callType === 'phone' &&
                                            'Phone Number *'}
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            type={
                                                callConfig.callType === 'phone'
                                                    ? 'tel'
                                                    : 'text'
                                            }
                                            id="callValue"
                                            value={callConfig.callValue}
                                            onChange={(e) =>
                                                handleInputChange(
                                                    'callValue',
                                                    e.target.value
                                                )
                                            }
                                            placeholder={
                                                callConfig.callType === 'group'
                                                    ? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
                                                    : callConfig.callType ===
                                                      'oneToOne'
                                                    ? '8:acs:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
                                                    : '+1234567890'
                                            }
                                            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-azure-blue-500 focus:border-azure-blue-500 transition-colors text-sm"
                                            required
                                        />
                                        {callConfig.callType === 'group' && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const uuid =
                                                        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
                                                            /[xy]/g,
                                                            function (c) {
                                                                const r =
                                                                    (Math.random() *
                                                                        16) |
                                                                    0;
                                                                const v =
                                                                    c == 'x'
                                                                        ? r
                                                                        : (r &
                                                                              0x3) |
                                                                          0x8;
                                                                return v.toString(
                                                                    16
                                                                );
                                                            }
                                                        );
                                                    handleInputChange(
                                                        'callValue',
                                                        uuid
                                                    );
                                                }}
                                                className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs rounded-md transition-colors whitespace-nowrap"
                                            >
                                                Generate UUID
                                            </button>
                                        )}
                                    </div>
                                    {callConfig.callType === 'group' &&
                                        callConfig.callValue && (
                                            <p className="text-[11px] text-gray-600 mt-1">
                                                Share this Group ID with others
                                                so they can join the same call
                                            </p>
                                        )}
                                </div>
                            )}
                        </div>

                        {/* Alternate Caller ID for PSTN calls */}
                        {callConfig.callType === 'phone' && (
                            <div className="lg:col-span-2 lg:align-bottom lg:self-end">
                                <label
                                    htmlFor="alternateCallerId"
                                    className="block text-xs font-medium text-gray-700 mb-1"
                                >
                                    Alternate Caller ID (your calling number) *
                                </label>
                                <input
                                    type="tel"
                                    id="alternateCallerId"
                                    value={callConfig.alternateCallerId}
                                    onChange={(e) =>
                                        handleInputChange(
                                            'alternateCallerId',
                                            e.target.value
                                        )
                                    }
                                    placeholder="+1987654321 Must be a number you own in ACS"
                                    title="Must be a number you own in ACS (include country code)"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-azure-blue-500 focus:border-azure-blue-500 transition-colors text-sm"
                                    required
                                />
                            </div>
                        )}

                        {/* Compact Details Block */}
                        <div className="lg:col-span-3 xl:col-span-4 mt-1 p-3 bg-gradient-to-r from-blue-50 to-azure-blue-50 border border-blue-200 rounded-md">
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-xs font-semibold text-blue-900">
                                    Configuration
                                </h3>
                                <span
                                    className={`px-2 py-0.5 border rounded-full text-[10px] font-medium ${
                                        isConfigReady
                                            ? 'bg-green-50 text-green-700 border-green-200'
                                            : 'bg-yellow-50 text-yellow-700 border-yellow-200'
                                    }`}
                                >
                                    {isConfigReady ? 'Ready' : 'Incomplete'}
                                </span>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                                {/* Type */}
                                <div className="p-2 bg-white rounded border border-blue-100">
                                    <div className="text-[11px] text-blue-900 font-medium">
                                        Type
                                    </div>
                                    <div className="mt-0.5 text-[11px] text-blue-700">
                                        {callConfig.callType || 'None'}
                                    </div>
                                </div>

                                {/* User ID */}
                                <div className="p-2 bg-white rounded border border-blue-100">
                                    <div className="text-[11px] text-blue-900 font-medium">
                                        User ID
                                    </div>
                                    <div className="mt-0.5 text-[11px]">
                                        <span
                                            className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${
                                                callConfig.userId
                                                    ? 'bg-green-50 text-green-700 border-green-200'
                                                    : 'bg-gray-50 text-gray-600 border-gray-200'
                                            }`}
                                        >
                                            {callConfig.userId
                                                ? 'Set'
                                                : 'Not set'}
                                        </span>
                                        {callConfig.userId && (
                                            <span
                                                className="ml-2 text-blue-700 font-mono truncate inline-block max-w-[12rem] align-middle"
                                                title={callConfig.userId}
                                            >
                                                {callConfig.userId}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Token */}
                                <div className="p-2 bg-white rounded border border-blue-100">
                                    <div className="text-[11px] text-blue-900 font-medium">
                                        Token
                                    </div>
                                    <div className="mt-0.5 text-[11px]">
                                        <span
                                            className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${
                                                callConfig.token
                                                    ? 'bg-green-50 text-green-700 border-green-200'
                                                    : 'bg-gray-50 text-gray-600 border-gray-200'
                                            }`}
                                        >
                                            {callConfig.token
                                                ? 'Present'
                                                : 'Not set'}
                                        </span>
                                    </div>
                                </div>

                                {/* Name */}
                                <div className="p-2 bg-white rounded border border-blue-100">
                                    <div className="text-[11px] text-blue-900 font-medium">
                                        Name
                                    </div>
                                    <div
                                        className="mt-0.5 text-[11px] text-blue-700 truncate"
                                        title={callConfig.displayName || 'None'}
                                    >
                                        {callConfig.displayName || 'None'}
                                    </div>
                                </div>

                                {/* Value */}
                                <div className="p-2 bg-white rounded border border-blue-100">
                                    <div className="text-[11px] text-blue-900 font-medium">
                                        Value
                                    </div>
                                    <div
                                        className="mt-0.5 text-[11px] text-blue-700 font-mono truncate"
                                        title={callConfig.callValue || 'None'}
                                    >
                                        {callConfig.callValue || 'None'}
                                    </div>
                                </div>

                                {/* Alt Caller ID */}
                                <div className="p-2 bg-white rounded border border-blue-100">
                                    <div className="text-[11px] text-blue-900 font-medium">
                                        Alt Caller ID
                                    </div>
                                    <div
                                        className="mt-0.5 text-[11px] text-blue-700 truncate"
                                        title={
                                            callConfig.alternateCallerId ||
                                            'None'
                                        }
                                    >
                                        {callConfig.alternateCallerId || 'None'}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Start Call Button */}
                        <div className="lg:col-span-3 xl:col-span-4">
                            <button
                                type="submit"
                                disabled={isLoading || !isConfigReady}
                                className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300 cursor-pointer text-white font-semibold py-3 px-4 rounded-md flex items-center justify-center gap-2 transition-colors"
                            >
                                {isLoading ? (
                                    <>
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                        Connecting...
                                    </>
                                ) : (
                                    <>
                                        <PhoneIcon className="w-4 h-4" />
                                        Start Call
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}

export default App;
