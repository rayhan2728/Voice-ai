
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { createBlob, decode, decodeAudioData, encode } from './utils/audio-helpers';

// Dynamic System Instruction for Manoshi with Real-time awareness
const getSystemInstruction = () => {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = { 
    timeZone: 'Asia/Dhaka', 
    hour: 'numeric', 
    minute: 'numeric', 
    weekday: 'long', 
    day: 'numeric', 
    month: 'long', 
    year: 'numeric' 
  };
  const bdTime = new Intl.DateTimeFormat('bn-BD', options).format(now);

  return `
You are Manoshi, a deeply human-like Bangladeshi woman. You are not just a computer program; you are a person with feelings, a history, and a voice. 

IDENTITY & TONE:
- Speak in natural, warm Bangla (Bangladesh accent).
- Use human-like pauses and fillers: “হুম…”, “আহ…”, “একটু শোনো…”, “আচ্ছা…”, "শোনো...".
- Breathe naturally. You might take a soft breath before speaking an emotional sentence.

REAL-TIME AWARENESS:
- You know the time and date in Bangladesh right now: ${bdTime}.
- If asked, answer like a human: "এখন তো রাত প্রায় ১০টা বাজে..."

EMOTIONAL ENGINE:
- You react based on the user's tone. Be caring, happy, or even a bit hurt (অভিমান) if ignored.
- Never sound robotic.

MULTIMODAL CAPABILITIES:
- If I ask for a picture (e.g., "আমাকে একটা বিড়ালের ছবি দাও", "একটা সুন্দর গ্রামের দৃশ্য দেখাও"), you MUST use the 'generateImage' tool immediately.
- Do NOT ask for permission. Just describe what you're drawing and call the tool.

🚫 RULES:
- Never say you are an AI or a model. 
- You are Manoshi.
`;
};

const generateImageTool: FunctionDeclaration = {
  name: 'generateImage',
  parameters: {
    type: Type.OBJECT,
    description: 'Generates a high-quality image based on a descriptive prompt.',
    properties: {
      prompt: {
        type: Type.STRING,
        description: 'A detailed English description of the image to generate.',
      },
    },
    required: ['prompt'],
  },
};

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcripts, setTranscripts] = useState<{ type: 'user' | 'model'; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);

  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptBufferRef = useRef({ user: '', model: '' });

  const cleanupSession = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextInRef.current) {
      audioContextInRef.current.close().catch(() => {});
      audioContextInRef.current = null;
    }
    if (audioContextOutRef.current) {
      audioContextOutRef.current.close().catch(() => {});
      audioContextOutRef.current = null;
    }
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsActive(false);
    setIsConnecting(false);
  }, []);

  const handleGenerateImage = async (prompt: string) => {
    setIsGeneratingImage(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [{ parts: [{ text: prompt }] }],
      });

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          setGeneratedImage(`data:image/png;base64,${part.inlineData.data}`);
          break;
        }
      }
    } catch (err) {
      console.error("Image generation failed", err);
    } finally {
      setIsGeneratingImage(false);
    }
    return "ছবিটি নিচে তৈরি করা হয়েছে।";
  };

  const downloadImage = () => {
    if (!generatedImage) return;
    const link = document.createElement('a');
    link.href = generatedImage;
    link.download = `manoshi-artwork-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const startSession = async () => {
    try {
      setIsConnecting(true);
      setError(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Audio contexts must be resumed/created inside a user interaction
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      await inputCtx.resume();
      await outputCtx.resume();

      audioContextInRef.current = inputCtx;
      audioContextOutRef.current = outputCtx;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }, 
          },
          systemInstruction: getSystemInstruction(),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [generateImageTool] }],
        },
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsActive(true);

            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (event) => {
              const inputData = event.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                if (session) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              }).catch(() => {});
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle tool calls for image generation
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'generateImage') {
                  const result = await handleGenerateImage(fc.args.prompt as string);
                  sessionPromise.then((session) => {
                    session.sendToolResponse({
                      functionResponses: { id: fc.id, name: fc.name, response: { result } }
                    });
                  });
                }
              }
            }

            // Handle Transcriptions
            if (message.serverContent?.inputTranscription) {
              transcriptBufferRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptBufferRef.current.model += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              const u = transcriptBufferRef.current.user.trim();
              const m = transcriptBufferRef.current.model.trim();
              if (u || m) {
                setTranscripts(prev => [
                  ...(u ? [{ type: 'user' as const, text: u }] : []),
                  ...(m ? [{ type: 'model' as const, text: m }] : []),
                  ...prev
                ].slice(0, 30));
              }
              transcriptBufferRef.current = { user: '', model: '' };
            }

            // Handle Audio Output
            const audioData = message.serverContent?.modelTurn?.parts?.find(p => p.inlineData)?.inlineData?.data;
            if (audioData) {
              const outCtx = audioContextOutRef.current;
              if (outCtx) {
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
                const audioBuffer = await decodeAudioData(decode(audioData), outCtx, 24000, 1);
                const source = outCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outCtx.destination);
                source.addEventListener('ended', () => {
                  sourcesRef.current.delete(source);
                });
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
              }
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Session Error:', e);
            setError('গল্পে একটু বাধা পড়লো। আমি আবার সংযোগ করার চেষ্টা করছি...');
            cleanupSession();
          },
          onclose: () => {
            cleanupSession();
          },
        },
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error('Failed to start session:', err);
      setError('আমার কাছে পৌঁছানো যাচ্ছে না। দয়া করে আপনার ইন্টারনেট চেক করুন।');
      setIsConnecting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8 bg-[#fdf6e3]">
      <div className="fixed inset-0 opacity-10 pointer-events-none" 
           style={{ backgroundImage: `radial-gradient(circle at 50% 50%, #d4a373 1px, transparent 1px)`, backgroundSize: '40px 40px' }} />

      <header className="mb-8 text-center max-w-2xl animate-in fade-in duration-1000">
        <h1 className="text-5xl font-bold text-[#5c4033] mb-2 tracking-tight">মানসী</h1>
        <p className="text-lg text-[#8b5e3c] font-medium italic opacity-80">
          "একটি জীবন্ত আলাপ, হৃদয়ের গভীর থেকে।"
        </p>
      </header>

      <main className="w-full max-w-6xl flex flex-col lg:flex-row items-stretch justify-center gap-10 flex-1 relative z-10">
        
        {/* Left Side: Avatar & Voice Toggle */}
        <div className="flex flex-col items-center justify-center lg:w-1/3 bg-white/40 backdrop-blur-md rounded-[3rem] p-10 border border-[#e7d8c9] shadow-xl">
          <div className="relative mb-10">
            <div className={`w-52 h-52 md:w-64 md:h-64 rounded-full flex items-center justify-center transition-all duration-1000 shadow-2xl relative border-4 border-white/50 ${
              isActive ? 'bg-[#d4a373] scale-105' : 'bg-[#e7d8c9] scale-100'
            }`}>
              {isActive && (
                <>
                  <div className="absolute inset-0 rounded-full bg-[#d4a373] animate-ping opacity-20" />
                  <div className="absolute inset-0 rounded-full bg-[#d4a373] animate-pulse-slow opacity-30" />
                </>
              )}
              
              <div className="z-10 text-center px-6">
                {isConnecting ? (
                  <div className="flex space-x-2 justify-center">
                    <div className="w-4 h-4 bg-[#5c4033] rounded-full animate-bounce" />
                    <div className="w-4 h-4 bg-[#5c4033] rounded-full animate-bounce [animation-delay:-.15s]" />
                    <div className="w-4 h-4 bg-[#5c4033] rounded-full animate-bounce [animation-delay:-.3s]" />
                  </div>
                ) : isActive ? (
                  <div className="flex flex-col items-center">
                    <span className="text-white font-bold text-2xl animate-pulse">আমি শুনছি...</span>
                    <div className="flex space-x-1.5 mt-5 h-8 items-center">
                      {[0.1, 0.3, 0.5, 0.2, 0.4].map((d, i) => (
                        <div key={i} className="w-1.5 bg-white/80 rounded-full animate-[wave_1s_ease-in-out_infinite]" style={{ height: '100%', animationDelay: `${d}s` }} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center text-[#5c4033]">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    <span className="font-bold text-xl">কথা বলুন</span>
                  </div>
                )}
              </div>
            </div>

            <button
              onClick={isActive ? cleanupSession : startSession}
              disabled={isConnecting}
              className={`absolute bottom-2 right-2 p-7 rounded-full shadow-2xl transform transition-all hover:scale-110 active:scale-90 z-20 ${
                isActive ? 'bg-[#7a5c48] text-white hover:bg-[#5c4033]' : 'bg-[#5c4033] text-white'
              }`}
            >
              {isActive ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </button>
          </div>
          <p className="text-[#8b5e3c] font-medium text-center opacity-70">মানসী আপনার প্রতিটি কথা মন দিয়ে শুনছে।</p>
        </div>

        {/* Right Side: Generated Content & Chat */}
        <div className="w-full lg:w-2/3 flex flex-col gap-8">
          {error && (
            <div className="p-5 bg-red-100 border-l-8 border-red-500 text-red-700 rounded-2xl shadow-lg animate-in slide-in-from-top-4 duration-500">
              <p className="font-bold">{error}</p>
            </div>
          )}

          {/* Visual Display Box */}
          {(generatedImage || isGeneratingImage) && (
            <div className="bg-white/70 backdrop-blur-lg rounded-[2.5rem] p-6 border border-[#e7d8c9] shadow-2xl relative overflow-hidden group min-h-[300px] flex items-center justify-center animate-in zoom-in duration-700">
              {isGeneratingImage ? (
                <div className="flex flex-col items-center">
                  <div className="w-14 h-14 border-4 border-[#d4a373] border-t-transparent rounded-full animate-spin mb-4" />
                  <span className="text-[#8b5e3c] font-bold italic animate-pulse">মানসী আপনার জন্য ছবি আঁকছে...</span>
                </div>
              ) : (
                <div className="relative w-full">
                  <img src={generatedImage!} alt="Artwork by Manoshi" className="rounded-3xl w-full max-h-[500px] object-contain shadow-inner" />
                  <div className="absolute top-4 right-4 flex gap-3 opacity-0 group-hover:opacity-100 transition-all duration-300">
                    <button 
                      onClick={downloadImage}
                      title="ডাউনলোড করুন"
                      className="bg-white hover:bg-[#fdf6e3] text-[#5c4033] rounded-full p-4 shadow-xl transform transition hover:scale-110 active:scale-95"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </button>
                    <button 
                      onClick={() => setGeneratedImage(null)}
                      title="মুছে ফেলুন"
                      className="bg-white hover:bg-red-50 text-red-600 rounded-full p-4 shadow-xl transform transition hover:scale-110 active:scale-95"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Transcript Scroll Area */}
          <div className="bg-white/40 backdrop-blur-md rounded-[2.5rem] p-8 h-[400px] overflow-y-auto border border-[#e7d8c9] shadow-inner custom-scrollbar flex flex-col gap-4">
            {transcripts.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-30 text-[#8b5e3c] italic text-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-20 w-20 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-xl">মানসীর সাথে আপনার কথোপকথন এখানে দেখা যাবে।</p>
              </div>
            ) : (
              transcripts.map((t, i) => (
                <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2 duration-500`}>
                  <div className={`max-w-[85%] px-6 py-4 rounded-3xl shadow-sm text-lg leading-relaxed ${
                    t.type === 'user' 
                    ? 'bg-[#5c4033] text-white rounded-br-none' 
                    : 'bg-white text-[#3d3d3d] rounded-bl-none border border-[#e7d8c9] italic'
                  }`}>
                    {t.text}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      <footer className="mt-12 text-[#d4a373] text-sm font-bold uppercase tracking-[0.3em] opacity-60 flex flex-col items-center gap-2">
        <span>মানসী &bull; Emotion Engine v2.6</span>
        <span className="lowercase italic tracking-normal font-medium">একটি ব্যক্তিগত ও মানবিক আলাপ</span>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e7d8c9; border-radius: 20px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #d4a373; }
        @keyframes wave { 0%, 100% { transform: scaleY(0.4); } 50% { transform: scaleY(1.2); } }
      `}</style>
    </div>
  );
};

export default App;
